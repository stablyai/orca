import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import { requireLegacyAgentSessionAccountHome } from '../../shared/agent-session/lifecycle/agent-session-account-home'
import type { AiVaultConversationCopy } from '../../shared/ai-vault-resume-preparation'
import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { ProviderAcquisitionStarts } from '../provider-process/provider-acquisition-starts'
import { piRpcSessionlessEnvironment } from '../pi/rpc-launch'
import { readPiSessionHeader, samePiDirectory } from '../pi/rpc-launch-resolution'
import type { PiRpcConnection, PiRpcSessionAdapterDeps } from '../pi/rpc-session-contract'
import { buildOmpRpcLaunch } from './rpc-launch'
import { openOmpRpcConnection } from './rpc-connection'

type CopyInput = Parameters<NonNullable<StructuredAgentSessionAdapter['copyConversation']>>[0]
const copyStateSchema = z.object({ sessionFile: z.string().min(1), sessionId: z.string().min(1) })

/** A separate native fork never switches or reopens the chat's writer. */
export class OmpRpcConversationCopies {
  private readonly children = new ProviderAcquisitionStarts<PiRpcConnection>()
  private readonly shutdown = new AbortController()
  private readonly pending = new Set<Promise<unknown>>()

  constructor(
    private readonly deps: Pick<
      PiRpcSessionAdapterDeps,
      'resolveLaunch' | 'openConnection' | 'logger'
    >
  ) {}

  copy: NonNullable<StructuredAgentSessionAdapter['copyConversation']> = async (input) => {
    const signal = AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(60_000)])
    const copy = this.run(input, signal)
    this.pending.add(copy)
    try {
      return await copy
    } finally {
      this.pending.delete(copy)
    }
  }

  private async run(input: CopyInput, signal: AbortSignal): Promise<AiVaultConversationCopy> {
    let connection: PiRpcConnection | undefined
    let scratch: string | undefined
    let copy: AiVaultConversationCopy
    let released = true
    try {
      signal.throwIfAborted()
      const launch = await waitForPromiseWithSignal(
        this.deps.resolveLaunch({ identity: input.identity, spawnToken: randomUUID() }),
        signal
      )
      signal.throwIfAborted()
      const account = requireLegacyAgentSessionAccountHome(input.accountHome)
      const selectedHome = launch.env?.PI_CODING_AGENT_DIR
      if (
        account.variable !== 'PI_CODING_AGENT_DIR' ||
        !selectedHome ||
        !(await samePiDirectory(account.path, selectedHome))
      ) {
        throw new Error("The OMP copy must use this chat's account.")
      }
      const source = launch.sessionFile
      if (
        !source ||
        !isAbsolute(source) ||
        launch.previous?.handle.nativeId !== input.providerSessionId
      ) {
        throw new Error('The saved OMP conversation changed before it could be copied.')
      }
      const original = await readPiSessionHeader(source, { titleSlot: true })
      if (!original?.id || !(await samePiDirectory(original.cwd, launch.cwd))) {
        throw new Error('The saved OMP conversation is unavailable.')
      }
      scratch = await mkdtemp(join(tmpdir(), 'orca-omp-copy-'))
      const config = join(scratch, 'copy.yml')
      // A copy must not schedule inherited Goal turns before the terminal takes ownership.
      await writeFile(config, 'goal:\n  continuationModes: []\n', { mode: 0o600 })
      signal.throwIfAborted()
      const environment = piRpcSessionlessEnvironment(launch.env ?? {})
      connection = (this.deps.openConnection ?? openOmpRpcConnection)(
        buildOmpRpcLaunch({
          ...launch,
          ...environment,
          envToDelete: [...(launch.envToDelete ?? []), ...environment.envToDelete],
          sessionFile: undefined,
          forkFile: source,
          extraArgs: [...(launch.extraArgs ?? []), '--no-extensions', '--config', config]
        }),
        {}
      )
      this.children.retainFailed(randomUUID(), connection)
      const state = copyStateSchema.parse(
        await waitForPromiseWithSignal(connection.request('get_state'), signal)
      )
      if (
        !isAbsolute(state.sessionFile) ||
        state.sessionId === original.id ||
        (await samePiDirectory(state.sessionFile, source))
      ) {
        throw new Error('OMP returned the original conversation instead of a copy.')
      }
      const saved = await readPiSessionHeader(state.sessionFile, { titleSlot: true })
      if (saved?.id !== state.sessionId || !(await samePiDirectory(saved.cwd, launch.cwd))) {
        throw new Error('OMP did not save a valid conversation copy.')
      }
      signal.throwIfAborted()
      copy = { sessionId: state.sessionId, filePath: state.sessionFile }
    } finally {
      if (connection) {
        const result = await connection.close().catch(() => null)
        if (result?.root !== 'exited') {
          released = false
          this.deps.logger.warn('OMP copy child exit is unproven; retained for cleanup', {
            scope: 'omp-rpc-copy',
            sessionId: input.identity.sessionId
          })
        }
      }
      if (scratch) {
        await rm(scratch, { recursive: true, force: true, maxRetries: 3 }).catch((error) =>
          this.deps.logger.warn('OMP copy scratch cleanup failed', {
            scope: 'omp-rpc-copy',
            error
          })
        )
      }
    }
    if (!released) {
      throw new Error('OMP could not release the copied conversation. Try again later.')
    }
    return copy
  }

  async closeAll(): Promise<void> {
    this.shutdown.abort()
    await Promise.allSettled(this.pending)
    await Promise.all(this.children.failedSessionIds().map((id) => this.children.stopFailed(id)))
  }
}
