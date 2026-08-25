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
    await this.run(['open', 'about:blank'])
    const tabs = await this.readTabs()
    const active = tabs.find((tab) => tab.active) ?? tabs[0]
    if (!active) {
      throw new BrowserError(
        BROWSER_UNAVAILABLE_ERROR_CODE,
        'The browser launched without an automation target.'
      )
    }
    return active.tabId
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
    const env = {
      ...process.env,
      AGENT_BROWSER_EXECUTABLE_PATH: this.launch.executablePath,
      AGENT_BROWSER_PROFILE: this.profilePath,
      AGENT_BROWSER_SESSION: this.sessionName,
      AGENT_BROWSER_ARGS: this.launch.browserArgs?.join('\n') ?? ''
    }
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
