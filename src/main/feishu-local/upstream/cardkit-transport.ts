/** Copyright (c) 2026 ByteDance Ltd. and/or its affiliates. SPDX-License-Identifier: MIT
 * Adapted from larksuite/openclaw-lark cardkit.ts at the revision in UPSTREAM.md. */
export type CardKitRequest = (
  method: 'POST' | 'PUT' | 'PATCH',
  path: string,
  data: unknown
) => Promise<void>

export function streamCardContent(
  request: CardKitRequest,
  cardId: string,
  content: string,
  sequence: number
): Promise<void> {
  return request('PUT', `/open-apis/cardkit/v1/cards/${cardId}/elements/answer/content`, {
    content,
    sequence
  })
}
export function updateCardKitCard(
  request: CardKitRequest,
  cardId: string,
  card: unknown,
  sequence: number
): Promise<void> {
  return request('PUT', `/open-apis/cardkit/v1/cards/${cardId}`, {
    card: { type: 'card_json', data: JSON.stringify(card) },
    sequence
  })
}
export function setCardStreamingMode(
  request: CardKitRequest,
  cardId: string,
  streamingMode: boolean,
  sequence: number
): Promise<void> {
  return request('PATCH', `/open-apis/cardkit/v1/cards/${cardId}/settings`, {
    settings: JSON.stringify({ config: { streaming_mode: streamingMode } }),
    sequence
  })
}
