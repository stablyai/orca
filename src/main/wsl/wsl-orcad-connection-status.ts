import type { OrcadTerminalCensus } from '../../shared/orcad-terminal-census'
import type { WslLivenessUnverifiableReason } from './wsl-orcad-liveness-verdict'

/**
 * What C7's UI shows for one WSL host, published with every `onChange`. `terminals` is the
 * verdict the distro itself proves for every terminal in it; null leaves terminals to orcad
 * (after a reconnect, `census` says how many its daemon still runs).
 */
export type WslOrcadConnectionStatus =
  | { state: 'connecting' }
  | { state: 'ready'; census: OrcadTerminalCensus | null }
  | {
      state: 'reconnecting'
      reason: 'orcad-exited' | 'distro-restarted' | 'distro-stopped' | 'census'
      attempt: number
      /** Until the next try; null while one runs. */
      retryInMs: number | null
      terminals: 'exited' | 'unverifiable'
    }
  | {
      state: 'distro-stopped'
      terminals: 'exited'
      /** False: nothing user-visible needs it, so it is not booted; it reconnects once running. */
      recovering: boolean
    }
  | {
      state: 'unverifiable'
      reason: WslLivenessUnverifiableReason
      terminals: 'unverifiable'
    }
  /** orcad stopped (crash or managed idle exit) with nothing user-visible on it; not relaunched. */
  | { state: 'idle'; terminals: 'unverifiable' }
  | { state: 'failed'; reason: string; terminals: 'exited' | 'unverifiable' }
  | { state: 'closed' }
