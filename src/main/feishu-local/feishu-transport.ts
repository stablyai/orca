import type { FeishuMessage } from './feishu-message'

export type FeishuReply = { type: 'text' | 'post' | 'file'; content: unknown }
export type FeishuTransport = {
  listen(
    ready: () => void,
    reconnecting: () => void,
    receive: (message: FeishuMessage) => Promise<void>
  ): Promise<void>
  original(mid: string): Promise<unknown>
  download(mid: string, key: string, kind: 'image' | 'file', limit: number): Promise<Buffer>
  upload(name: string, bytes: Uint8Array): Promise<string>
  reply(mid: string, chat: string, message: FeishuReply, uuid: string): Promise<void>
}

/** A recalled original or a missing topic cannot accept another reply. */
export class FeishuReplyTargetGone extends Error {}
export class FeishuPermissionError extends Error {}
export class FeishuUploadPermissionError extends Error {}
