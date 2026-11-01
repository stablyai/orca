import '../assets/main.css'

import ReactDOM from 'react-dom/client'
import { getDefaultSettings } from '../../../shared/constants'
import { applyDocumentTheme } from '../lib/document-theme'
import { installBodyOverlayAttributes } from '../lib/body-overlay-attributes'
import { useAppStore } from '../store'
import { installWebPreloadApi } from '../web/web-preload-api'
import type { ComponentFixtureTheme } from './component-fixture'
import {
  listComponentFixtures,
  loadComponentFixture,
  type ComponentFixtureEntry
} from './component-fixture-registry'
import { ComponentFixtureFrame, markComponentFixtureState } from './ComponentFixtureFrame'

type FixtureSummary = { id: string; file: string }

// Driven by config/scripts/component-fixtures/fixture-server.mjs to re-render in a warm page.
type ComponentFixtureHost = {
  render: (id: string, theme: ComponentFixtureTheme) => Promise<void>
  list: () => Promise<FixtureSummary[]>
}

function parseTheme(value: string | null): ComponentFixtureTheme {
  return value === 'light' ? 'light' : 'dark'
}

const params = new URLSearchParams(window.location.search)
const pageTheme = parseTheme(params.get('theme'))

markComponentFixtureState('loading')
// Reuse browser-build window.api defaults without pairing a runtime.
installWebPreloadApi()
// Fixtures preview the desktop renderer; keep web-only component branches off.
Reflect.deleteProperty(window, '__ORCA_WEB_CLIENT__')
const defaultSettings = getDefaultSettings('/home/fixture')
useAppStore.setState({ settings: { ...defaultSettings, theme: pageTheme } })
const baseStoreState = useAppStore.getState()
document.body.classList.add('bg-background')
installBodyOverlayAttributes()

function requireRootElement(): HTMLElement {
  const element = document.getElementById('root')
  if (!element) {
    throw new Error('Fixture root element not found.')
  }
  return element
}

const rootElement = requireRootElement()
let root: ReactDOM.Root | null = null

function freshRoot(): ReactDOM.Root {
  root?.unmount()
  root = ReactDOM.createRoot(rootElement)
  return root
}

function applyTheme(theme: ComponentFixtureTheme): void {
  applyDocumentTheme(theme, { disableTransitions: false })
}

function fixtureHref(id: string, linkTheme: ComponentFixtureTheme): string {
  return `?${new URLSearchParams({ id, theme: linkTheme }).toString()}`
}

function FixtureIndex({ entries }: { entries: ComponentFixtureEntry[] }): React.JSX.Element {
  const otherTheme = pageTheme === 'dark' ? 'light' : 'dark'
  return (
    <div className="min-h-dvh bg-background p-6 text-foreground">
      <h1 className="mb-1 text-base font-semibold">Component fixtures</h1>
      <p className="mb-4 text-xs text-muted-foreground">
        {entries.length} fixtures · files named *.fixture.tsx under src/renderer/src
      </p>
      <ul className="space-y-1 text-sm">
        {entries.map((entry) => (
          <li key={entry.id} className="flex items-baseline gap-3">
            <a className="font-mono hover:underline" href={fixtureHref(entry.id, pageTheme)}>
              {entry.id}
            </a>
            <a
              className="text-xs text-muted-foreground hover:underline"
              href={fixtureHref(entry.id, otherTheme)}
            >
              {otherTheme}
            </a>
            <span className="truncate text-xs text-muted-foreground">{entry.file}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

async function renderFixture(id: string, theme: ComponentFixtureTheme): Promise<void> {
  markComponentFixtureState('loading')
  const target = freshRoot()
  // Why replace: each fixture starts from the same seeded store, even in a reused page.
  useAppStore.setState(baseStoreState, true)
  useAppStore.setState({ settings: { ...defaultSettings, theme } })
  applyTheme(theme)
  try {
    const entry = await loadComponentFixture(id)
    if (entry.fixture.store) {
      useAppStore.setState(entry.fixture.store)
    }
    entry.fixture.setup?.()
    target.render(
      <ComponentFixtureFrame fixture={entry.fixture}>
        {entry.fixture.render()}
      </ComponentFixtureFrame>
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    markComponentFixtureState('error', message)
    target.render(<pre className="p-4 text-xs text-destructive">{message}</pre>)
  }
}

async function listFixtures(): Promise<FixtureSummary[]> {
  return (await listComponentFixtures()).map(({ id, file }) => ({ id, file }))
}

const host: ComponentFixtureHost = { render: renderFixture, list: listFixtures }
Object.assign(window, { __orcaComponentFixtureHost: host })

const requestedId = params.get('id')
applyTheme(pageTheme)
if (requestedId) {
  void renderFixture(requestedId, pageTheme)
} else if (params.has('worker')) {
  markComponentFixtureState('ready')
} else {
  void listComponentFixtures().then((entries) => {
    freshRoot().render(<FixtureIndex entries={entries} />)
    markComponentFixtureState('ready')
  })
}
