import { runHostedIosChatE2e } from './hosted-ios-chat-e2e.mjs'
import { runHostedIosOtaE2e } from './hosted-ios-ota-e2e.mjs'

export function runHostedIosFocusedE2e(args) {
  return args.options.chatOnly ? runHostedIosChatE2e(args) : runHostedIosOtaE2e(args)
}
