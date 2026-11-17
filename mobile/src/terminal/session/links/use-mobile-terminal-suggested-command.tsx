import { useCallback, useState } from 'react'
import { Copy, Play } from 'lucide-react-native'
import { ActionSheetModal } from '../../../components/sheets/ActionSheetModal'
import { useClipboardWriter } from '../../../platform/clipboard/clipboard'
import { triggerError, triggerSuccess } from '../../../platform/haptics/haptics'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import type { MobileSessionController } from '../../../session/use-mobile-session-controller'
import { terminalInputSend } from '../../host-operations/mobile-terminal-operations'
import {
  buildTerminalSendParams,
  TERMINAL_INPUT_SEND_OPTIONS
} from '../../input-delivery/terminal-send-request'

type SuggestedCommandController = Pick<
  MobileSessionController,
  'activeHandleRef' | 'activeSessionTab' | 'clientRef' | 'connStateRef' | 'deviceTokenRef'
>

type AskedCommand = { handle: string; text: string; tabId: string | undefined }

// Run or copy a `! command` an agent asked the person to run; nothing runs without the Run tap.
function SuggestedCommandSheet(props: {
  text: string
  onRun: () => void
  onClose: () => void
}): React.JSX.Element {
  const { text, onRun, onClose } = props
  const t = useMobileTranslation()
  const clipboard = useClipboardWriter()
  const [visible, setVisible] = useState(true)
  const [copied, setCopied] = useState(false)
  return (
    <ActionSheetModal
      visible={visible}
      title={t('session.suggestedCommandSheet.title', 'Run this command?')}
      // The title clips to one line; the message wraps, so every argument is read before Run.
      message={text}
      actions={[
        {
          id: 'runCommand',
          label: t('session.suggestedCommandSheet.run', 'Run in this terminal'),
          icon: Play,
          closeBeforePress: true,
          onPress: onRun
        },
        {
          id: 'copyCommand',
          label: copied
            ? t('common.copied', 'Copied')
            : t('session.suggestedCommandSheet.copy', 'Copy command'),
          icon: Copy,
          onPress: () => {
            void clipboard.writeText(text).then(
              () => {
                triggerSuccess()
                setCopied(true)
              },
              () => triggerError()
            )
          }
        }
      ]}
      onClose={() => setVisible(false)}
      onAfterClose={onClose}
    />
  )
}

export function useMobileTerminalSuggestedCommand(controller: SuggestedCommandController) {
  const { activeHandleRef, clientRef, connStateRef, deviceTokenRef } = controller
  const tabId = controller.activeSessionTab?.id
  const [asked, setAsked] = useState<AskedCommand | null>(null)
  // A sheet asked from one tab must not reappear after the person returns to it.
  if (asked && asked.tabId !== tabId) {
    setAsked(null)
  }
  const handleRunSuggestedCommand = useCallback(
    (handle: string, text: string) => {
      if (handle === activeHandleRef.current) {
        setAsked({ handle, text, tabId })
      }
    },
    [activeHandleRef, tabId]
  )
  const run = useCallback(
    (command: AskedCommand) => {
      const client = clientRef.current
      if (!client || connStateRef.current !== 'connected') {
        triggerError()
        return
      }
      // The host pastes the text and presses Enter once the agent has taken the paste.
      void terminalInputSend
        .request(
          client,
          buildTerminalSendParams({
            terminal: command.handle,
            text: command.text,
            enter: true,
            deviceToken: deviceTokenRef.current
          }),
          TERMINAL_INPUT_SEND_OPTIONS
        )
        .then(
          (reply) =>
            terminalInputSend.interpret(reply) === true ? triggerSuccess() : triggerError(),
          () => triggerError()
        )
    },
    [clientRef, connStateRef, deviceTokenRef]
  )
  const suggestedCommandSheet =
    asked && asked.tabId === tabId ? (
      <SuggestedCommandSheet
        text={asked.text}
        onRun={() => run(asked)}
        onClose={() => setAsked(null)}
      />
    ) : null
  return { handleRunSuggestedCommand, suggestedCommandSheet }
}
