import type Database from '../sqlite/sync-database'
import { cardData, type FeishuResponseChange } from './feishu-card-data'
import type { FeishuCardStore } from './feishu-card-store'
import { responseCardId, responseDestination } from './feishu-card-links'
import { FeishuWorkerResponses } from './feishu-worker-responses'

export class FeishuResponseStore {
  private readonly workers: FeishuWorkerResponses
  constructor(
    private readonly db: Database.Database,
    private readonly cards: FeishuCardStore
  ) {
    this.workers = new FeishuWorkerResponses(db)
  }
  workerResponse = (...args: Parameters<FeishuWorkerResponses['destination']>) =>
    this.workers.destination(...args)

  private handoff(
    account: string,
    id: string,
    external: string,
    chat: string,
    change: Extract<FeishuResponseChange, { kind: 'handoff' }>
  ) {
    const target = this.cards.get(account, id)
    const previous = responseDestination(
      this.cards,
      account,
      responseCardId(this.db, account, change.from),
      external,
      chat
    )
    const newer =
      previous &&
      this.db
        .prepare(
          'SELECT 1 FROM feishu_cards WHERE account=? AND id=? AND rowid>(SELECT rowid FROM feishu_cards WHERE account=? AND id=?)'
        )
        .get(account, id, account, previous.id)
    if (
      !newer ||
      !target ||
      !previous ||
      previous.id === id ||
      target.external !== external ||
      target.chat !== chat
    ) {
      return id
    }
    const data = cardData.parse(JSON.parse(target.body))
    const before = cardData.parse(JSON.parse(previous.body))
    if (
      !data.response ||
      data.response.supersededBy ||
      data.response.final !== undefined ||
      !before.response ||
      before.response.final !== undefined ||
      (data.response.native && data.response.native.turnItemId !== change.turnItemId) ||
      (before.response.native && before.response.native.turnItemId !== change.turnItemId)
    ) {
      return id
    }
    data.response.turn = before.response.turn
    data.response.native = before.response.native
    data.response.baseline = before.response.native
    data.response.question = before.response.question
    before.response.supersededBy = id
    before.response.stoppedAt = change.at
    before.text = '已转至最新提问'
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.cards.put(account, previous.id, external, previous.original, chat, before)
      this.cards.put(account, id, external, target.original, chat, data)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return id
  }

  update(
    account: string,
    external: string,
    original: string | null,
    chat: string,
    change: FeishuResponseChange
  ) {
    let id = original ? responseCardId(this.db, account, original) : null
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
    if (change.kind === 'handoff') {
      return this.handoff(account, id, external, chat, change)
    }
    let card = this.cards.get(account, id)
    if (card && (change.kind !== 'begin' || id !== `response:${original}`)) {
      card = responseDestination(this.cards, account, id, external, chat)
      if (!card) {
        return null
      }
      id = card.id
    }
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
    if (
      original &&
      change.kind === 'begin' &&
      id !== `response:${original}` &&
      response.continuation !== original
    ) {
      response.history = [
        ...(response.history ?? []),
        {
          turnItemId: response.native?.turnItemId ?? card?.id ?? original,
          startedAt: response.native?.startedAt ?? response.turn ?? 0,
          messages: [
            ...(response.native?.messages ?? []),
            ...response.progress,
            ...(response.final ? [{ id: 'previous-final', text: response.final }] : [])
          ],
          tools: response.native?.tools ?? []
        }
      ].slice(-10)
      response.progress = []
      response.continuation = original
      response.native = undefined
      response.final = undefined
      response.phase = 'working'
      response.turn = undefined
      data.text = '正在处理'
    }
    if (
      response.continuation &&
      ((change.kind === 'native' &&
        !change.value.report &&
        !change.value.deliveries?.includes(response.continuation)) ||
        (change.kind === 'final' &&
          original !== response.continuation &&
          !response.native?.deliveries?.includes(response.continuation)))
    ) {
      return id
    }
    if (
      change.kind === 'final' &&
      change.turnItemId &&
      response.native &&
      change.turnItemId !== response.native.turnItemId
    ) {
      return id
    }
    // A late activity, reconnect snapshot or retried progress must never reopen a final answer.
    if (response.supersededBy || (response.final !== undefined && change.kind !== 'native')) {
      return id
    }
    switch (change.kind) {
      case 'native':
        if (
          response.native &&
          (change.value.startedAt < response.native.startedAt ||
            (response.final !== undefined &&
              !change.value.report &&
              change.value.turnItemId !== response.native.turnItemId))
        ) {
          return id
        }
        const previous =
          response.native?.turnItemId === change.value.turnItemId ? response.native : undefined
        if (previous?.completedAt !== undefined && change.value.completedAt === undefined) {
          return id
        }
        if (change.value.report && !previous) {
          if (response.native) {
            response.history = [...(response.history ?? []), response.native].slice(-10)
          }
          response.final = undefined
          response.progress = []
          response.phase = 'working'
        }
        this.workers.remember(
          account,
          external,
          original ?? card!.original,
          change.value.workers ?? []
        )
        response.native = {
          ...change.value,
          ...(previous?.workers || change.value.workers
            ? {
                workers: [
                  ...new Set([...(previous?.workers ?? []), ...(change.value.workers ?? [])])
                ]
              }
            : {}),
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
        if (change.value.report && change.value.completedAt !== undefined) {
          response.final = response.native.messages.at(-1)?.text ?? ''
          response.phase = 'done'
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
