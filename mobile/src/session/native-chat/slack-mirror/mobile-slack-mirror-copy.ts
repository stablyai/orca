import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import type { SlackMirrorCopy } from '../../../../../src/shared/connectors/slack-mirror-state'

/** One line of the shared Slack mirror copy, in the phone's language. */
export function useMobileSlackMirrorCopy(): (copy: SlackMirrorCopy) => string {
  const t = useMobileTranslation()
  return (copy) => t(copy.key, copy.text, copy.values)
}
