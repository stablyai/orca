import { createNonSecureContextUuid as createUuidV4 } from '../../../../../../src/shared/identifiers/non-secure-context-uuid'
import { useCallback } from 'react'
import type { RpcClient } from '../../../../transport/rpc/rpc-client-contract'
import { useMediaPicker } from '../../../../platform/media-picking/media-picker'
import type { MobilePickedFileSource } from '../../../../platform/media-picking/media-picker-contract'
import { agentSessionAttachmentTerminalTarget } from '../../../../../../src/shared/agent-session/agent-session-attachments'
import { uploadMobileAgentSessionAttachmentBytes } from '../../../../files/attachments/mobile-agent-session-attachment-upload'
import {
  mobileNativeChatDraftDestination,
  updateMobileNativeChatDraftInputs
} from '../drafts/mobile-native-chat-draft-inputs'
import { setMobileNativeChatDraftText } from '../drafts/mobile-native-chat-draft-store'
import { uploadPickedNativeChatFiles } from './mobile-native-chat-file-attachment'
import { translate } from '../../../../i18n/mobile-i18n'

type ShowToast = (message: string, durationMs?: number) => void

const NOOP = (): void => {}

/** Plain words, not an @ mention: a mentioned PDF reaches Claude Code's model as its size alone. */
export function nativeChatDraftWithFile(draft: string, path: string): string {
  const separator = draft.length === 0 || /\s$/.test(draft) ? '' : ' '
  const reference = translate(
    'session.nativeChatFileAttachments.terminalFileReference',
    'File from my phone, saved on this computer as {{path}}',
    { path: `\`${path}\`` }
  )
  // The trailing space keeps the next typed word off the reference.
  return `${draft}${separator}[${reference}] `
}

/** A terminal has no chat attachment list, so each file streams to the host and its path joins the draft. */
export function useMobileNativeChatTerminalFileAttachments(args: {
  client: RpcClient | null
  terminal: string | null
  scopeKey: string | null
  enabled: boolean
  showToast: ShowToast
}): ((from: MobilePickedFileSource) => Promise<void>) | undefined {
  const { client, terminal, scopeKey, enabled, showToast } = args
  const picker = useMediaPicker()

  const attach = useCallback(
    async (from: MobilePickedFileSource): Promise<void> => {
      if (!client || !terminal || !scopeKey || !enabled) {
        return
      }
      // Follow the chat that asked: a tab switch mid-upload must not move the path to another draft.
      const destination = mobileNativeChatDraftDestination(scopeKey)
      updateMobileNativeChatDraftInputs(destination, (current) => ({
        ...current,
        pending: (current.pending ?? 0) + 1
      }))
      try {
        await uploadPickedNativeChatFiles({
          canContinue: () => destination.active,
          picked: picker.pickFiles(from),
          upload: (file) =>
            uploadMobileAgentSessionAttachmentBytes(client, {
              sessionId: agentSessionAttachmentTerminalTarget(terminal),
              name: file.name,
              byteLength: file.byteLength,
              bytes: file.readBytes()
            }),
          nextId: createUuidV4,
          onPicked: NOOP,
          onStored: (_id, stored) =>
            setMobileNativeChatDraftText(destination, (draft) =>
              nativeChatDraftWithFile(draft, stored.path)
            ),
          onFailed: NOOP,
          onError: (message) => {
            if (destination.active) {
              showToast(message)
            }
          }
        })
      } finally {
        updateMobileNativeChatDraftInputs(destination, (current) => ({
          ...current,
          pending: Math.max(0, (current.pending ?? 0) - 1)
        }))
      }
    },
    [client, enabled, picker, scopeKey, showToast, terminal]
  )
  return client && terminal && scopeKey && enabled ? attach : undefined
}
