import type { MountAdapter } from '../recording-scenario'
import { mountFixture } from '../recorder-fixture-shape'
import type { operationModuleLoader } from '../operation-module-loader'

const TERMINAL = 'terminal-1'
const DEVICE_TOKEN = 'device-token-1'

/**
 * The three writes native chat makes to a terminal — the message body, the standalone input clear
 * and the paced command typing — plus the host-side record of a session-option pick.
 *
 * Each is an exported async function taking a client. The send's delivery-unknown arm is the reason
 * these are recorded rather than reasoned about: a cutover and an ack loss must both answer
 * `unknown`, and only a recording shows which of the three outcomes a given failure produced.
 */
export function nativeChatWriteMountAdapters(
  modules: ReturnType<typeof operationModuleLoader>
): Record<string, MountAdapter> {
  return {
    'nativeChat.terminal-write': ({ client }) => {
      const send = modules.load<typeof import('../../../session/mobile-native-chat-send')>(
        'mobile/src/session/mobile-native-chat-send.ts'
      )
      const outcomes: Record<string, unknown> = {}
      return {
        action(name, args) {
          const mobileClient = { id: DEVICE_TOKEN, type: 'mobile' as const }
          const shared = {
            client,
            terminal: TERMINAL,
            ...(args.anonymous === true ? {} : { mobileClient }),
            ...(args.deadline === undefined ? {} : { deadline: Number(args.deadline) })
          }
          const request =
            name === 'clear'
              ? send.clearMobileNativeChatInput(
                  mountFixture<Parameters<typeof send.clearMobileNativeChatInput>[0]>({
                    ...shared,
                    clearInput: '\x15'
                  })
                )
              : name === 'command'
                ? send.typeMobileNativeChatCommandWithOutcome(
                    mountFixture<Parameters<typeof send.typeMobileNativeChatCommandWithOutcome>[0]>(
                      { ...shared, command: 'ok' }
                    )
                  )
                : send.sendMobileNativeChatMessageWithOutcome(
                    mountFixture<Parameters<typeof send.sendMobileNativeChatMessageWithOutcome>[0]>(
                      {
                        ...shared,
                        text: 'hello',
                        ...(args.enter === false ? { enter: false } : {}),
                        ...(args.draft === true
                          ? { resolvedLaunchDraft: { text: 'hello', createdAt: 0 } }
                          : {})
                      }
                    )
                  )
          return request.then((value: unknown) => {
            outcomes[name] = value
            return value
          })
        },
        state: () => ({ ...outcomes }),
        dispose: () => {}
      }
    },
    'nativeChat.session-option-pick': ({ client }) => {
      const persist = modules.load<
        typeof import('../../../session/mobile-native-chat-session-option-persistence')
      >(
        'mobile/src/session/mobile-native-chat-session-option-persistence.ts'
      ).persistMobileStructuredOptionPicks
      let settled: unknown = 'unsent'
      return {
        action: (name) =>
          persist(
            mountFixture<Parameters<typeof persist>[0]>({
              client,
              agent: 'claude',
              // An empty pick list returns before the wire; the write is best-effort either way.
              picks: name === 'empty' ? [] : [{ modelId: 'opus', optionId: 'model', value: 'opus' }]
            })
          ).then((value: unknown) => {
            settled = value === undefined ? 'settled' : value
            return value
          }),
        state: () => ({ settled }),
        dispose: () => {}
      }
    }
  }
}
