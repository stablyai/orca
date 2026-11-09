import { describe, expect, it } from 'vitest'
import type { Page } from 'playwright'
import {
  browser,
  closeChildren,
  enablePopupAdapterProbe,
  guest,
  origin,
  receipts,
  setPopupFixtureEvidenceName,
  snapshots,
  status
} from './browser-popup-compatibility-cdp-fixture'
import { waitForHiddenFrameInput } from '../../../electron-fixtures/hidden-frame-input-readiness-fixture'

enablePopupAdapterProbe()
setPopupFixtureEvidenceName('adapter-electron-evidence.json')

type CreationPath = 'adopted' | 'native'
const creationPaths = ['adopted', 'native'] as const

function eventsSince(offset: number): Record<string, unknown>[] {
  return status().adapterProbe?.slice(offset) ?? []
}

async function childAt(url: string): Promise<Page> {
  await expect
    .poll(() =>
      browser
        ?.contexts()
        .flatMap((context) => context.pages())
        .some((candidate) => candidate.url() === url)
    )
    .toBe(true)
  const child = browser
    ?.contexts()
    .flatMap((context) => context.pages())
    .find((candidate) => candidate.url() === url)
  if (!child) {
    throw new Error('Missing probe child')
  }
  return child
}

async function configure(page: Page, path: CreationPath): Promise<void> {
  await page.evaluate((path) => console.log(`orca-popup-fixture:probe-${path}`), path)
}

describe('Electron popup adapter API limits (not an admission safety gate)', () => {
  it.each(creationPaths)(
    'cannot distinguish inherited script restrictions synchronously: %s',
    async (path) => {
      const records = await exerciseSandboxControls(path, 'script')
      expect(records[0].preferences).toEqual(records[1].preferences)
      expect(records[0].frameOrigin).toBe(records[1].frameOrigin)
      if (path === 'adopted') {
        expect(withoutRequestMarker(records[0].optionsPreferences)).toEqual(
          withoutRequestMarker(records[1].optionsPreferences)
        )
      }
    }
  )

  it.each(creationPaths)(
    'preserves inherited link restrictions without exposing sandbox flags: %s',
    async (path) => {
      const records = await exerciseSandboxControls(path, 'link')
      const preferences = records.map((record) => record.optionsPreferences)
      expect(preferences[0]).not.toHaveProperty('openerSandboxFlags')
      expect(preferences[1]).not.toHaveProperty('openerSandboxFlags')
      expect(preferences[2]).not.toHaveProperty('openerSandboxFlags')
      if (path === 'adopted') {
        expect(records.every((record) => record.event === 'createWindow')).toBe(true)
      }
    }
  )
})

function withoutRequestMarker(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) {
    return value
  }
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !['additionalArguments', 'session'].includes(key))
  )
}

async function installSandboxFrame(
  page: Page,
  sandbox: string,
  destination: string,
  kind: string
): Promise<void> {
  await page.evaluate(
    ({ sandbox, destination, kind }) => {
      document.querySelector('#sandbox-probe')?.remove()
      const frame = document.createElement('iframe')
      frame.id = 'sandbox-probe'
      if (sandbox !== 'unsandboxed') {
        frame.setAttribute(
          'sandbox',
          `allow-scripts allow-popups${sandbox === 'escape' ? ' allow-popups-to-escape-sandbox' : ''}`
        )
      }
      frame.srcdoc =
        kind === 'script'
          ? `<button id="open" onclick="window.open('${destination}', '_blank', 'noopener')">Open</button>`
          : `<a id="open" href="${destination}" target="_blank" rel="noopener">Open</a>`
      document.body.append(frame)
    },
    { sandbox, destination, kind }
  )
}

async function exerciseSandboxControls(
  path: CreationPath,
  kind: 'script' | 'link'
): Promise<Record<string, unknown>[]> {
  const page = guest('probe-one')
  await configure(page, path)
  const records: Record<string, unknown>[] = []
  for (const sandbox of ['restricted', 'escape', 'unsandboxed']) {
    const destination = `${origin}/sandbox-${path}-${kind}-${sandbox}`
    const offset = status().adapterProbe?.length ?? 0
    await installSandboxFrame(page, sandbox, destination, kind)
    const open = page.frameLocator('#sandbox-probe').locator('#open')
    await waitForHiddenFrameInput(open)
    await open.click(kind === 'link' ? { modifiers: ['Shift'] } : {})
    const child = await childAt(destination)
    expect(await child.evaluate('window.opener === null')).toBe(true)
    const before = receipts.length
    await child.evaluate((action) => {
      const form = document.createElement('form')
      form.action = action
      form.method = 'POST'
      document.body.append(form)
      form.submit()
    }, `${origin}/sandbox-form-${path}-${kind}-${sandbox}`)
    if (sandbox === 'restricted') {
      await expect
        .poll(() => eventsSince(offset).some((event) => event.event === 'sandbox-form-blocked'))
        .toBe(true)
      expect(
        receipts.slice(before).some((receipt) => receipt.path.startsWith('/sandbox-form-'))
      ).toBe(false)
      expect(child.url()).toBe(destination)
    } else {
      await expect
        .poll(() =>
          receipts.slice(before).some((receipt) => receipt.path.startsWith('/sandbox-form-'))
        )
        .toBe(true)
    }
    await page.evaluate('console.log("orca-popup-fixture:snapshot")')
    const creation = eventsSince(offset).find(
      (event) => event.event === (path === 'adopted' ? 'createWindow' : 'did-create-window')
    )
    if (!creation) {
      throw new Error('Missing creation event')
    }
    records.push(creation)
    expect(status().windowsHidden).toBe(true)
    snapshots.push(status())
    await closeChildren(page)
  }
  return records
}
