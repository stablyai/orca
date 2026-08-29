import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { BrowserError } from '../browser/browser-error'
import { BROWSER_UNAVAILABLE_ERROR_CODE } from '../../shared/runtime-types'
import { runProcess } from '../../shared/child-process/run-process'

const COMMAND_TIMEOUT_MS = 90_000
const MAX_OUTPUT_BYTES = 50 * 1024 * 1024
const CLOSE_TIMEOUT_MS = 5_000

export type ExternalChromiumLaunch = {
  executablePath: string
  browserArgs?: readonly string[]
  provider: 'electron' | 'chromium'
}

const AgentBrowserTab = z.object({
  active: z.boolean(),
  tabId: z.string(),
  title: z.string(),
  url: z.string()
})
const AgentBrowserTabsResult = z.object({ tabs: z.array(AgentBrowserTab).optional() })
const AgentBrowserScreenshotResult = z.object({ path: z.string().min(1) })
const AgentBrowserEnvelope = z.object({
  success: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().nullable().optional()
})

export type AgentBrowserTab = z.infer<typeof AgentBrowserTab>

function classifyAgentBrowserError(message: string): string {
  if (/unknown ref|ref not found|element not found: @e/i.test(message)) {
    return 'browser_stale_ref'
  }
  if (/evaluation error/i.test(message)) {
    return 'browser_eval_error'
  }
  if (/navigation|net::err/i.test(message)) {
    return 'browser_navigation_failed'
  }
  if (/timed out|timeout/i.test(message)) {
    return 'browser_timeout'
  }
  if (/tab.*not found|unknown tab/i.test(message)) {
    return 'browser_tab_not_found'
  }
  return 'browser_error'
}

// Why no AGENT_BROWSER_IDLE_TIMEOUT_MS here: unlike a per-tab helper daemon, this one owns the
// user's remote Chromium tree, so idling it out would close their live browser and every tab in it.
// The stable session name plus the `close` in start() is what reclaims a killed orcad's tree (#16367).
export function externalChromiumAgentBrowserEnvironment(options: {
  inheritedEnv: NodeJS.ProcessEnv
  executablePath: string
  profilePath: string
  sessionName: string
  browserArgs?: readonly string[]
}): NodeJS.ProcessEnv {
  return {
    ...options.inheritedEnv,
    AGENT_BROWSER_EXECUTABLE_PATH: options.executablePath,
    AGENT_BROWSER_PROFILE: options.profilePath,
    AGENT_BROWSER_SESSION: options.sessionName,
    AGENT_BROWSER_ARGS: options.browserArgs?.join('\n') ?? ''
  }
}

export class ExternalChromiumBrowserSession {
  private readonly profilePath: string
  private readonly sessionName: string

  constructor(
    private readonly agentBrowserPath: string,
    private readonly launch: ExternalChromiumLaunch,
    statePath: string
  ) {
    const identity = createHash('sha256')
      .update(`${statePath}:${launch.provider}`)
      .digest('hex')
      .slice(0, 16)
    this.sessionName = `orca-orcad-${identity}`
    this.profilePath = join(statePath, `browser-${launch.provider}`)
  }

  async start(): Promise<string> {
    await mkdir(this.profilePath, { recursive: true })
    // Why: the session name is stable across runs, so a daemon an earlier orcad left behind is
    // still driving the user's Chromium. Unlike the pane bridge this session never passes --cdp,
    // so nothing binds it to the old process — a surviving one is reusable as-is, and closing it
    // would take the remote user's browser and every tab with it (#16367).
    const reusable = await this.readActiveTabId()
    if (reusable) {
      return reusable
    }
    // Nothing answered, so anything under this name is wedged or half-dead; reclaim it.
    await this.stop()
    await this.run(['open', 'about:blank'])
    const opened = await this.readActiveTabId()
    if (!opened) {
      throw new BrowserError(
        BROWSER_UNAVAILABLE_ERROR_CODE,
        'The browser launched without an automation target.'
      )
    }
    return opened
  }

  private async readActiveTabId(): Promise<string | null> {
    try {
      const tabs = await this.readTabs()
      return (tabs.find((tab) => tab.active) ?? tabs[0])?.tabId ?? null
    } catch {
      return null
    }
  }

  async stop(): Promise<void> {
    try {
      await this.run(['close'], CLOSE_TIMEOUT_MS)
    } catch {
      // Closing an already-dead browser is complete cleanup.
    }
  }

  async selectPage(agentPageId: string): Promise<void> {
    await this.run(['tab', agentPageId])
  }

  async readTabs(): Promise<AgentBrowserTab[]> {
    return AgentBrowserTabsResult.parse(await this.run(['tab'])).tabs ?? []
  }

  async screenshot(params: Record<string, unknown>, full: boolean): Promise<unknown> {
    const format = params.format === 'jpeg' ? 'jpeg' : 'png'
    const command = ['screenshot', ...(full ? ['--full'] : []), '--screenshot-format', format]
    const result = AgentBrowserScreenshotResult.parse(await this.run(command))
    const data = (await readFile(result.path)).toString('base64')
    await rm(result.path, { force: true }).catch(() => undefined)
    return { data, format }
  }

  async pdf(): Promise<unknown> {
    const outputPath = join(this.profilePath, `capture-${randomUUID()}.pdf`)
    await this.run(['pdf', outputPath])
    const data = (await readFile(outputPath)).toString('base64')
    await rm(outputPath, { force: true }).catch(() => undefined)
    return { data }
  }

  async run(command: readonly string[], timeoutMs = COMMAND_TIMEOUT_MS): Promise<unknown> {
    const args = ['--session', this.sessionName, '--profile', this.profilePath]
    if (this.launch.browserArgs?.length) {
      args.push('--args', this.launch.browserArgs.join('\n'))
    }
    args.push(...command, '--json')
    const env = externalChromiumAgentBrowserEnvironment({
      inheritedEnv: process.env,
      executablePath: this.launch.executablePath,
      profilePath: this.profilePath,
      sessionName: this.sessionName,
      browserArgs: this.launch.browserArgs
    })
    const result = await runProcess({
      program: this.agentBrowserPath,
      args,
      env,
      timeoutMs,
      maxOutputBytes: MAX_OUTPUT_BYTES
    })
    if (result.timedOut) {
      throw new BrowserError('browser_timeout', 'Browser command timed out.')
    }
    let envelope: z.infer<typeof AgentBrowserEnvelope>
    try {
      envelope = AgentBrowserEnvelope.parse(JSON.parse(result.stdout))
    } catch {
      const detail = result.stderr.trim() || `exit ${String(result.code)}`
      throw new BrowserError('browser_error', `Browser command failed: ${detail.slice(0, 1000)}`)
    }
    if (!envelope.success) {
      const message = envelope.error ?? (result.stderr.trim() || 'Unknown browser error.')
      throw new BrowserError(classifyAgentBrowserError(message), message)
    }
    return envelope.data
  }
}
