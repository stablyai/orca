import type {
  HerdrHostTransport,
  HerdrResponse,
  HerdrTerminalController,
  HerdrTerminalControlOptions
} from './herdr-runtime-contract'
import { HerdrRuntimeError } from './herdr-runtime-contract'
import { herdrStockCliInvocation } from './herdr-stock-cli-request'
import { HerdrCliSessionManager } from './herdr-cli-session'
import {
  createHerdrSessionControlController,
  herdrSessionControlArgs
} from './herdr-session-control'

export { localHerdrCommand } from './herdr-command'

export type HerdrCliHostTransportOptions = {
  commandFor: (herdrArgs: string[]) => { file: string; args: string[]; env?: NodeJS.ProcessEnv }
  serverCommandFor?: (sessionName: string) => {
    file: string
    args: string[]
    env?: NodeJS.ProcessEnv
  }
  timeoutMs?: number
}

export class HerdrCliHostTransport implements HerdrHostTransport {
  private readonly sessionManager: HerdrCliSessionManager

  constructor(private readonly options: HerdrCliHostTransportOptions) {
    this.sessionManager = new HerdrCliSessionManager({
      commandFor: options.commandFor,
      serverCommandFor: options.serverCommandFor,
      timeoutMs: options.timeoutMs
    })
  }

  async ensureSession(sessionName: string): Promise<void> {
    await this.sessionManager.ensureSession(sessionName)
  }

  async request<T>(
    sessionName: string,
    method: string,
    params: unknown
  ): Promise<HerdrResponse<T>> {
    const invocation = herdrStockCliInvocation(sessionName, method, params)
    const stdout = await this.sessionManager.run(invocation.args)
    try {
      return invocation.parse(stdout) as HerdrResponse<T>
    } catch (error) {
      throw new HerdrRuntimeError(
        'herdr_invalid_response',
        `Stock Herdr returned an invalid response for ${method}: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  }

  controlTerminal(
    sessionName: string,
    target: string,
    options: HerdrTerminalControlOptions
  ): HerdrTerminalController {
    return createHerdrSessionControlController(
      this.options.commandFor(herdrSessionControlArgs(sessionName, target, options))
    )
  }
}
