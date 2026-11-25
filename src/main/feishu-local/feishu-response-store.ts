import type Database from '../sqlite/sync-database'
import { cardData, type FeishuResponseChange } from './feishu-card-data'
import type { FeishuCardStore } from './feishu-card-store'

export class FeishuResponseStore {
  constructor(
    private readonly db: Database.Database,
    private readonly cards: FeishuCardStore
  ) {}

  update(
    account: string,
    external: string,
    original: string | null,
    chat: string,
    change: FeishuResponseChange
  ) {
    let id = original ? `response:${original}` : null
    if (!id) {
      const turn = change.kind !== 'start' && 'turn' in change ? change.turn : undefined
      const found = this.db
        .prepare(
          `SELECT id FROM feishu_cards WHERE account=? AND external=? AND json_extract(body,'$.kind')='response'
         ${turn != null ? "AND json_extract(body,'$.response.turn')=?" : ''} ORDER BY rowid DESC LIMIT 1`
        )
        .get(...(turn != null ? [account, external, turn] : [account, external]))
      id = found ? String(found.id) : null
    }
    if (!id) {
      return null
    }
    const card = this.cards.get(account, id)
    if (!card && !original) {
      return null
    }
    const data = card
      ? cardData.parse(JSON.parse(card.body))
      : {
          kind: 'response' as const,
          text: '正在处理',
          options: [],
          response: { phase: 'working' as const, progress: [], trace: [] }
        }
    const response = data.response
    if (!response || (card && (card.external !== external || card.chat !== chat))) {
      return null
    }
    // A late activity, reconnect snapshot or retried progress must never reopen a final answer.
    if (response.final !== undefined && change.kind !== 'native') {
      return id
    }
    switch (change.kind) {
      case 'native':
        if (
          response.native &&
          (change.value.startedAt < response.native.startedAt ||
            (response.final !== undefined &&
              change.value.turnItemId !== response.native.turnItemId))
        ) {
          return id
        }
        const previous =
          response.native?.turnItemId === change.value.turnItemId ? response.native : undefined
        if (previous?.completedAt !== undefined && change.value.completedAt === undefined) {
          return id
        }
        response.native = {
          ...change.value,
          tools: [
            ...new Map(
              [...(previous?.tools ?? []), ...change.value.tools].map((t) => [t.id, t])
            ).values()
          ].slice(-60),
          messages: [
            ...new Map(
              [...(previous?.messages ?? []), ...change.value.messages].map((m) => [m.id, m])
            ).values()
          ].slice(-20)
        }
        break
      case 'begin':
        break
      case 'start':
        response.turn = change.turn
        break
      case 'status':
        data.text = change.text
        break
      case 'trace':
        if (response.trace.at(-1) !== change.text) {
          response.trace = [...response.trace, change.text.slice(0, 500)].slice(-60)
        }
        break
      case 'progress':
        if (!response.progress.some((entry) => entry.id === change.id)) {
          response.progress.push({ id: change.id, text: change.text })
        }
        break
      case 'final':
        response.final = change.text
        response.phase = change.failed ? 'failed' : 'done'
        data.text = change.failed ? '处理失败' : '已完成'
        break
    }
    this.cards.put(account, id, external, card?.original ?? original!, chat, data)
    return id
  }
}
