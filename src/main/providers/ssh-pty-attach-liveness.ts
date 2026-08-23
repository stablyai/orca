import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import type { SshPtyReceivingActivationLease } from './ssh-pty-notification-routing'
import type { PtySourceReceivingActivation } from '../../shared/pty-source-receiving-activation'
import { requestSshPtyAttach } from './ssh-pty-session-reattach'
import type { SshPtyLivenessState } from './ssh-pty-liveness-state'

export async function attachSshPtyWithLiveEvidence(args: {
  mux: SshChannelMultiplexer
  appPtyId: string
  relayPtyId: string
  installSourceActivation: (
    relayPtyId: string,
    activation: PtySourceReceivingActivation
  ) => SshPtyReceivingActivationLease
  rememberPtyIncarnation: (relayPtyId: string, incarnationId: unknown) => void
  livenessState: SshPtyLivenessState
}): Promise<void> {
  let liveEvidence: ReturnType<SshPtyLivenessState['beginLiveEvidence']> | undefined =
    args.livenessState.beginLiveEvidence(args.appPtyId)
  try {
    await requestSshPtyAttach({
      mux: args.mux,
      relayPtyId: args.relayPtyId,
      params: { id: args.relayPtyId },
      commitSourceActivation: true,
      installSourceActivation: args.installSourceActivation,
      rememberPtyIncarnation: args.rememberPtyIncarnation
    })
    args.livenessState.settleLiveEvidence(args.appPtyId, liveEvidence, true)
    liveEvidence = undefined
  } finally {
    if (liveEvidence) {
      args.livenessState.settleLiveEvidence(args.appPtyId, liveEvidence, false)
    }
  }
}
