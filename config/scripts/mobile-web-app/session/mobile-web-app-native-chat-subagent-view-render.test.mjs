import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as esbuild from 'esbuild'
import { chromium } from 'playwright-core'
import {
  MOBILE_WEB_APP_ROOT_RESET,
  mobileWebAppBuildOptions
} from '../../build/mobile-web-app/build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from '../mobile-web-app-bundle-dependencies.mjs'
import { createBundleServer, readShellCsp } from '../preview/mobile-web-app-render-harness.mjs'

// A phone chat opens a subagent over itself from the journal rows it already holds, and Back finds the chat where it was.
const mobileDir = fileURLToPath(new URL('../../../../mobile', import.meta.url))
const REPLY = 'Defaults live in defaults.ts and useSettings merges them.'

// Composed as MobileNativeChatOverlay composes it; the journal is what a structured host sends.
const entry = `
import { createRoot } from 'react-dom/client'
import { useEffect, useMemo, useState } from 'react'
import { View } from 'react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { projectStructuredItemToNativeChat } from '../src/shared/agent-session/view/structured-agent-session-projection'
import { foldStructuredAgentSubagentRoster, NO_STRUCTURED_AGENT_SUBAGENT_ROSTER } from '../src/shared/agent-session/view/structured-agent-session-subagent-roster'
import { structuredSessionBackgroundTasksView } from '../src/shared/agent-session/view/structured-session-background-tasks-view'
import { agentChildRowContextForSessionStream } from '../src/shared/agent-status/presentation/agent-child-row-stream-context'
import { foldMobileNativeChatMessages } from './src/session/native-chat/transcript/projection/mobile-native-chat-render-data'
import { MobileNativeChatView } from './src/session/native-chat/MobileNativeChatView'
import { MobileNativeChatRowOverlaysHost } from './src/session/native-chat/transcript/message-actions/MobileNativeChatRowOverlaysHost'
import { MobileNativeChatBackgroundTasks } from './src/session/native-chat/input/tasks/MobileNativeChatBackgroundTasks'
import { useMobileNativeChatSubagents } from './src/session/native-chat/subagents/use-mobile-native-chat-subagents'
import { publishPageStorage } from './src/mobile-web-shell/bridge/page-storage/page-async-storage'
import { RpcClientProvider } from './src/transport/connection/client-context.web'

publishPageStorage({}, () => true, 'host', '')
const bridge = new Proxy({ getShellSession: () => null }, { get: (held, key) => held[key] ?? (() => () => {}) })
const T = Date.UTC(2026, 0, 1)
const SUB = { agentId: 'agent-explore', producerKind: 'agent' }
const payload = (head) => ({ head, byteLength: head.length, digest: 'd', truncated: false })
const item = (sequence, itemId, body, linkage) => ({ itemId, revision: 1, sequence, observedAt: T + sequence * 1000, body, ...linkage })
const say = (sequence, itemId, role, text, linkage) => item(sequence, itemId, { kind: 'message', role, blocks: [{ type: 'text', text }] }, linkage)
const journal = (done) => [
  ...Array.from({ length: 10 }, (_, i) => say(i + 1, 'note-' + i, 'assistant', 'Earlier note ' + i + ' about the build. '.repeat(4))),
  say(20, 'ask', 'user', 'Where does the settings page get its defaults?'),
  item(21, 'spawn', { kind: 'tool-call', name: 'Agent', callId: 'toolu_explore', state: done ? 'completed' : 'running',
    input: { description: 'Find the settings defaults', prompt: 'Find where the settings page reads its default values.' },
    ...(done ? { output: payload('[Subagent hand-back]\\n  ${REPLY}') } : {}) }),
  item(22, 'roster', { kind: 'message', role: 'assistant', blocks: [
    { type: 'subagent', id: 'agent-explore', label: 'Find the settings defaults', groupId: 'turn-1', run: 'toolu_explore', state: done ? 'completed' : 'working', startedAt: T },
    { type: 'text', text: 'Kicked off subagent Find the settings defaults' }] }),
  say(23, 'look', 'assistant', 'Searching the settings code.', SUB),
  ...(done ? [say(24, 'answer', 'assistant', 'They come from defaults.ts. ' + 'The page reads them once. '.repeat(12))] : [])
]
const tasks = {
  view: structuredSessionBackgroundTasksView({ state: 'monitoring', children: [{ id: 'child-1', providerId: 'agent-explore', kind: 'agent',
    description: 'Find the settings defaults', state: 'working', membership: 'live', firstObservedAt: T, observedAt: T, stoppable: false }] }, null),
  rowContext: agentChildRowContextForSessionStream(true, 0),
  sessionKey: 'chat',
  stop: async () => ({ status: 'rejected' })
}

function Chat() {
  const [done, setDone] = useState(location.hash === '#done')
  useEffect(() => { globalThis.finishSubagent = () => setDone(true) }, [])
  const items = useMemo(() => journal(done), [done])
  const messages = useMemo(() => items.map(projectStructuredItemToNativeChat).filter(Boolean), [items])
  const folded = useMemo(() => foldMobileNativeChatMessages(messages, 'claude'), [messages])
  const roster = useMemo(() => foldStructuredAgentSubagentRoster(NO_STRUCTURED_AGENT_SUBAGENT_ROSTER, items), [items])
  const subagents = useMobileNativeChatSubagents({ scopeKey: 'chat', messages, folded, agent: 'claude', source: { journalItems: items, roster } })
  return <MobileNativeChatRowOverlaysHost conversation={{ surfaceId: 'chat', sessionId: 'chat' }} linkOpenMode="ask" openSubagent={subagents.open}>
    <View style={{ flex: 1 }}>
      <MobileNativeChatView messages={messages} folded={folded} status="ready" agent="claude" structuredActivityUi
        streaming={null} sendSurfaceId="chat" getSendCompletionGeneration={() => 0} getComposerEditGeneration={() => 0}
        pending={[]} draftKey="chat" onComposerTextChange={() => {}} onSend={async () => false}
        composerTray={{ content: <MobileNativeChatBackgroundTasks tasks={tasks} /> }} covered={subagents.screen !== null} />
      {subagents.screen}
    </View>
  </MobileNativeChatRowOverlaysHost>
}
const metrics = { frame: { x: 0, y: 0, width: 390, height: 780 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }
createRoot(document.getElementById('root')).render(
  <RpcClientProvider client={bridge}><SafeAreaProvider initialMetrics={metrics}><Chat /></SafeAreaProvider></RpcClientProvider>
)
`

const bundles = mobileWebAppDependenciesPresent()
const describeRender = bundles ? describe : describe.skip
let scratch
let server
let origin
let browser

beforeAll(async () => {
  if (!bundles) {
    return
  }
  scratch = await mkdtemp(join(tmpdir(), 'orca-chat-subagent-view-'))
  const outDir = join(scratch, 'bundle')
  await esbuild.build({
    ...mobileWebAppBuildOptions([]),
    entryPoints: undefined,
    stdin: { contents: entry, resolveDir: mobileDir, loader: 'tsx', sourcefile: 'chat.tsx' },
    splitting: false,
    write: true,
    outdir: outDir,
    entryNames: 'chat',
    metafile: false
  })
  await writeFile(
    join(outDir, 'index.html'),
    '<!doctype html><html><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      `${MOBILE_WEB_APP_ROOT_RESET}</head>` +
      '<body><div id="root"></div><script type="module" src="/chat.js"></script></body></html>'
  )
  const served = await createBundleServer({ outDir, cspHeader: await readShellCsp() })
  server = served.server
  origin = served.origin
  const executablePath = process.env.ORCA_MOBILE_WEB_RENDER_BROWSER
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
}, 180_000)

afterAll(async () => {
  await browser?.close()
  server?.close()
  if (scratch) {
    await rm(scratch, { recursive: true, force: true })
  }
})

async function openChat(hash = '') {
  const context = await browser.newContext({
    viewport: { width: 390, height: 780 },
    isMobile: true
  })
  const page = await context.newPage()
  const failures = []
  page.on('pageerror', (error) => failures.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') failures.push(message.text())
  })
  await page.goto(`${origin}/${hash}`)
  try {
    await page.getByTestId('native-chat-view').waitFor({ timeout: 10_000 })
  } catch (error) {
    throw new Error(`The chat fixture did not mount: ${failures.join('\n')}`, { cause: error })
  }
  return page
}

const shown = (locator) => expect.poll(() => locator.isVisible()).toBe(true)

// The transcript's own scroller, under the chat view.
const chatScrollTop = (page) =>
  page.evaluate(
    () =>
      [...document.querySelectorAll('[data-testid="native-chat-view"] div')].find(
        (node) =>
          /auto|scroll/.test(getComputedStyle(node).overflowY) &&
          node.scrollHeight > node.clientHeight
      ).scrollTop
  )

describeRender('a subagent opened from a phone chat', () => {
  it('shows its prompt, steps and reply, and Back returns to the same place in the chat', async () => {
    const page = await openChat('#done')
    const tail = await chatScrollTop(page)
    // Read up from the tail, where a remounted chat would land instead.
    await page.mouse.move(195, 300)
    await page.mouse.wheel(0, -120)
    const entry = page
      .getByTestId('subagent-row')
      .getByRole('button', { name: 'Open Find the settings defaults' })
    await expect.poll(() => chatScrollTop(page)).toBeLessThan(tail - 100)
    await entry.scrollIntoViewIfNeeded()
    const place = await chatScrollTop(page)
    await entry.click()
    const view = page.getByTestId('subagent-view')
    await shown(view.getByText('Find where the settings page reads its default values.'))
    await shown(view.getByText('Searching the settings code.'))
    await shown(view.getByText(REPLY))
    expect(await view.getByText(/Subagent hand-back/).count()).toBe(0)
    expect(await view.getByText('They come from defaults.ts.').count()).toBe(0)
    await page.getByRole('button', { name: 'Back to Main agent' }).click()
    await expect.poll(() => page.getByTestId('subagent-view').count()).toBe(0)
    expect(await chatScrollTop(page)).toBe(place)
    await page.context().close()
  })

  it('opens a running subagent from the agents strip and shows its reply once it finishes', async () => {
    const page = await openChat()
    const strip = page.getByTestId('background-tasks-strip')
    await strip.getByRole('button').first().click()
    await strip.getByRole('button', { name: /^Open Find the settings defaults/ }).click()
    const view = page.getByTestId('subagent-view')
    await shown(view.getByText('Searching the settings code.'))
    expect(await view.getByText(REPLY).count()).toBe(0)
    await page.evaluate(() => globalThis.finishSubagent())
    await shown(view.getByText(REPLY))
    await page.context().close()
  })
})
