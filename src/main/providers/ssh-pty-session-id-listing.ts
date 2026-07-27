import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { JsonRpcErrorCode } from '../ssh/relay-protocol'
import { mapSshPtyProcessList } from './ssh-agent-session-process-list'
import { toAppSshPtyId } from './ssh-pty-id'
import type { PtyProcessInfo } from './types'

export class SshPtySessionIdLister {
  private support: boolean | null = null
  private probe: Promise<string[]> | null = null

  constructor(
    private readonly connectionId: string,
    private readonly mux: SshChannelMultiplexer
  ) {}

  async list(): Promise<string[]> {
    if (this.support === false) {
      return await this.fallback()
    }
    if (this.support === true) {
      return await this.request()
    }
    if (!this.probe) {
      this.probe = this.probeSupport().finally(() => {
        this.probe = null
      })
    }
    return await this.probe
  }

  private async request(): Promise<string[]> {
    const result = await this.mux.request('pty.listSessionIds')
    if (!Array.isArray(result) || !result.every((id) => typeof id === 'string' && id.length > 0)) {
      throw new Error('invalid_pty_session_id_list')
    }
    return result.map((id) => toAppSshPtyId(this.connectionId, id))
  }

  private async probeSupport(): Promise<string[]> {
    try {
      const ids = await this.request()
      this.support = true
      return ids
    } catch (error) {
      if ((error as { code?: unknown })?.code !== JsonRpcErrorCode.MethodNotFound) {
        throw error
      }
      this.support = false
      return await this.fallback()
    }
  }

  private async fallback(): Promise<string[]> {
    const result = await this.mux.request('pty.listProcesses')
    return mapSshPtyProcessList(result as PtyProcessInfo[], (id) =>
      toAppSshPtyId(this.connectionId, id)
    ).map(({ id }) => id)
  }
}
