import { Buffer } from 'buffer/'
import {
  MobileWebMarkdownDraftReadPayloadSchema,
  MobileWebMarkdownDraftReadResultSchema,
  MobileWebMarkdownDraftWritePayloadSchema
} from '../../../src/shared/mobile-web/bridge-operation-contract'
import {
  isMarkdownContentByteLengthOverLimit,
  MOBILE_MARKDOWN_EDIT_MAX_BYTES
} from '../../../src/shared/mobile-markdown-document'
import { MobileWebBrokerError } from './mobile-web-broker-error'
import type { MobileWebNativeCapabilityAuthority } from './mobile-web-native-capability-authority'
import type { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'

type MarkdownDraftArgs = {
  operation: string
  payload: unknown
  workspaceAuthority: MobileWebWorkspaceAuthority
  nativeAuthority: Pick<
    MobileWebNativeCapabilityAuthority,
    'sessionMarkdownDraftRead' | 'sessionMarkdownDraftWrite'
  >
}

/** Drafts live in device storage, so they never leave the shell. The desktop owns the document. */
export async function executeMobileWebMarkdownDraftOperation(
  args: MarkdownDraftArgs
): Promise<unknown> {
  if (args.operation === 'markdownDraftRead') {
    const payload = MobileWebMarkdownDraftReadPayloadSchema.parse(args.payload)
    const hostWorkspaceId = args.workspaceAuthority.hostWorkspaceId(payload.workspaceId)
    if (!args.nativeAuthority.sessionMarkdownDraftRead) {
      throw new MobileWebBrokerError('unsupported_capability')
    }
    const draft = await args.nativeAuthority.sessionMarkdownDraftRead(
      hostWorkspaceId,
      payload.tabId,
      payload.relativePath ?? ''
    )
    return MobileWebMarkdownDraftReadResultSchema.parse({
      workspaceId: payload.workspaceId,
      tabId: payload.tabId,
      ...(payload.relativePath ? { relativePath: payload.relativePath } : {}),
      draft: draft
        ? { contentBase64: encodeDraftContent(draft.content), baseVersion: draft.baseVersion }
        : null
    })
  }
  if (args.operation === 'markdownDraftWrite') {
    const payload = MobileWebMarkdownDraftWritePayloadSchema.parse(args.payload)
    const hostWorkspaceId = args.workspaceAuthority.hostWorkspaceId(payload.workspaceId)
    if (!args.nativeAuthority.sessionMarkdownDraftWrite) {
      throw new MobileWebBrokerError('unsupported_capability')
    }
    await args.nativeAuthority.sessionMarkdownDraftWrite(
      hostWorkspaceId,
      payload.tabId,
      payload.relativePath ?? '',
      payload.draft
        ? {
            content: decodeDraftContent(payload.draft.contentBase64),
            baseVersion: payload.draft.baseVersion
          }
        : null
    )
    return null
  }
  throw new MobileWebBrokerError('unsupported_capability')
}

function encodeDraftContent(content: string): string {
  if (isMarkdownContentByteLengthOverLimit(content, MOBILE_MARKDOWN_EDIT_MAX_BYTES)) {
    throw new MobileWebBrokerError('host_error')
  }
  return Buffer.from(content, 'utf8').toString('base64')
}

function decodeDraftContent(contentBase64: string): string {
  const bytes = Buffer.from(contentBase64, 'base64')
  const content = bytes.toString('utf8')
  if (
    bytes.byteLength > MOBILE_MARKDOWN_EDIT_MAX_BYTES ||
    !Buffer.from(content, 'utf8').equals(bytes)
  ) {
    throw new MobileWebBrokerError('invalid_request')
  }
  return content
}
