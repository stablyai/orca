import { describe, expect, it } from 'vitest'
import {
  boundedPollDelayMs,
  posixShellQuote,
  buildAcceptancePayload,
  evaluateWorktreeClosure,
  isCodexQuotaExhaustedRead,
  isCodexQuotaExhaustedText,
  lifecycleMessageForDispatch,
  parseAccountOrder,
  resolveCodexAccount
} from './orchestration-interaction-loop'

// 2026-08 實際擷取的 Codex provider 額度訊息（task_complete.error.message 原文）。
const REAL_PROVIDER_QUOTA_SAMPLE =
  "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Aug 8th, 2026 11:32 AM."

const accounts = [
  { id: 'id-3', email: 'three@example.com', workspaceLabel: 'Codex #3｜F Team' },
  { id: 'id-2', email: 'two@example.com', workspaceLabel: 'Codex #2｜H Team' },
  { id: 'id-1', email: 'one@example.com', workspaceLabel: 'Codex #1｜H 個人' }
]

describe('Orca 完整互動循環', () => {
  it('依編號自動建立 #3 → #2 → #1 順序', () => {
    expect(parseAccountOrder(undefined, accounts)).toEqual(['#3', '#2', '#1'])
  })

  it('以 ID、完整標籤、email 或唯一編號解析帳號', () => {
    expect(resolveCodexAccount(accounts, 'id-3').id).toBe('id-3')
    expect(resolveCodexAccount(accounts, 'Codex #2｜H Team').id).toBe('id-2')
    expect(resolveCodexAccount(accounts, 'one@example.com').id).toBe('id-1')
    expect(resolveCodexAccount(accounts, '#3').id).toBe('id-3')
  })

  it('額度字串以真實 provider 樣本驗證：行首錨定、容許後綴與兩種撇號', () => {
    expect(isCodexQuotaExhaustedText(REAL_PROVIDER_QUOTA_SAMPLE)).toBe(true)
    expect(isCodexQuotaExhaustedText('Usage limit reached.')).toBe(true)
    expect(isCodexQuotaExhaustedText("You've hit your usage limit.")).toBe(true)
    expect(isCodexQuotaExhaustedText('You’ve hit your usage limit. Try again later.')).toBe(true)
    // 行中引用（非行首）不構成證據。
    expect(isCodexQuotaExhaustedText('請測試字串 Usage limit reached 是否會被誤判')).toBe(false)
    expect(isCodexQuotaExhaustedText('The error text "usage limit" appeared mid-sentence')).toBe(
      false
    )
  })

  it('只認 system 訊息為 provider 額度證據；assistant 輸出可被任務素材誘導、一律不算', () => {
    const transcriptRead = (role: 'system' | 'assistant') => ({
      dispatchId: 'dispatch-1',
      source: 'transcript' as const,
      sourceIdentity: 'session-1',
      provider: 'codex' as const,
      fallbackReason: null,
      transcript: {
        messages: [
          {
            id: 'msg-1',
            role,
            blocks: [{ type: 'text' as const, text: REAL_PROVIDER_QUOTA_SAMPLE }],
            timestamp: null,
            source: 'transcript' as const
          }
        ],
        limited: false,
        nextCursor: '1',
        returnedMessageCount: 1
      },
      cursor: '1',
      status: { worker: 'running', terminal: 'running' as const },
      warnings: []
    })
    expect(isCodexQuotaExhaustedRead(transcriptRead('system'))).toBe(true)
    expect(isCodexQuotaExhaustedRead(transcriptRead('assistant'))).toBe(false)
  })

  it('reconcile 標記 rejected 的 worker_done 不得再被當成終態', () => {
    const messages = [
      {
        id: 'msg-rejected',
        from_handle: 'worker-1',
        type: 'worker_done',
        payload: JSON.stringify({
          dispatchId: 'dispatch-1',
          outcome: 'succeeded',
          _orcaLifecycleRejection: { reason: 'duplicate' }
        })
      },
      {
        id: 'msg-live',
        from_handle: 'worker-1',
        type: 'worker_done',
        payload: JSON.stringify({ dispatchId: 'dispatch-1', outcome: 'succeeded' })
      }
    ]
    expect(lifecycleMessageForDispatch(messages, 'dispatch-1')?.id).toBe('msg-live')
  })

  it('不以沒有作者身分的 terminal tail 作為切換帳號證據', () => {
    expect(
      isCodexQuotaExhaustedRead({
        dispatchId: 'dispatch-1',
        source: 'terminal',
        sourceIdentity: 'terminal-1',
        terminal: {
          handle: 'terminal-1',
          tail: ['Usage limit reached.'],
          status: 'running',
          nextCursor: '1',
          truncated: false
        },
        cursor: null,
        status: { worker: 'running', terminal: 'running' },
        fallbackReason: 'transcript_missing',
        warnings: []
      })
    ).toBe(false)
  })

  it('驗收回執明示不刪工作樹，並記錄被接手的 SHA', () => {
    const payload = JSON.parse(
      buildAcceptancePayload({
        taskId: 'task-1',
        dispatchId: 'dispatch-1',
        evidence: 'tests pass',
        worktreeCloseable: true,
        worktreeReason: 'clean',
        worktreeSha: 'abc1234def'
      })
    )
    expect(payload.outcome).toBe('accepted')
    expect(payload.worktree).toEqual({
      closeable: true,
      reason: 'clean',
      sha: 'abc1234def',
      removed: false
    })
  })

  it('只有完整、乾淨且已推送落地的 Git 狀態才能標記工作樹可關閉', () => {
    const pushedUpstream = { hasUpstream: true, ahead: 0, behind: 0 }
    expect(
      evaluateWorktreeClosure({
        entries: [],
        conflictOperation: 'unknown',
        didHitLimit: false,
        head: 'abc1234def5678',
        upstreamStatus: pushedUpstream
      }).closeable
    ).toBe(true)
    // 沒回報 HEAD SHA＝無法記錄被接手的狀態，不可關。
    expect(
      evaluateWorktreeClosure({
        entries: [],
        conflictOperation: 'unknown',
        didHitLimit: false,
        upstreamStatus: pushedUpstream
      })
    ).toEqual({
      closeable: false,
      reason: 'git status did not report a HEAD SHA, so the accepted state cannot be recorded'
    })
    // 乾淨但未推送＝工作樹仍握有唯一副本，不可關。
    expect(
      evaluateWorktreeClosure({
        entries: [],
        conflictOperation: 'unknown',
        didHitLimit: false,
        upstreamStatus: { hasUpstream: true, ahead: 2, behind: 0 }
      })
    ).toEqual({
      closeable: false,
      reason: 'branch is ahead of its upstream by 2 unpushed commit(s)'
    })
    // 沒有 upstream＝commit 未持久化到遠端，不可關。
    expect(
      evaluateWorktreeClosure({
        entries: [],
        conflictOperation: 'unknown',
        didHitLimit: false
      }).closeable
    ).toBe(false)
    // rebase/merge/cherry-pick 停在乾淨中間點時，工作樹仍被進行中的操作佔有。
    for (const conflictOperation of ['merge', 'rebase', 'cherry-pick'] as const) {
      expect(
        evaluateWorktreeClosure({ entries: [], conflictOperation, didHitLimit: false })
      ).toEqual({
        closeable: false,
        reason: `a ${conflictOperation} operation is still in progress`
      })
    }
    expect(
      evaluateWorktreeClosure({
        entries: [{ path: 'src/dirty.ts', status: 'modified', area: 'unstaged' }],
        conflictOperation: 'unknown',
        didHitLimit: false
      }).closeable
    ).toBe(false)
    expect(
      evaluateWorktreeClosure({
        entries: [],
        conflictOperation: 'unknown',
        didHitLimit: true
      })
    ).toEqual({ closeable: false, reason: 'git status was truncated' })
  })

  it('sleep 封頂：不超過剩餘期限且不為負', () => {
    expect(boundedPollDelayMs(2000, 10_000, 5_000)).toBe(2000)
    expect(boundedPollDelayMs(2000, 6_500, 5_000)).toBe(1500)
    expect(boundedPollDelayMs(2000, 5_000, 5_000)).toBe(0)
    expect(boundedPollDelayMs(2000, 4_000, 5_000)).toBe(0)
  })

  it('posixShellQuote：安全字元直通，其餘單引號包裹且不被 shell 展開', () => {
    expect(posixShellQuote('gpt-5.3-codex')).toBe('gpt-5.3-codex')
    // # 是 shell 註解起始字元，必須包裹，否則 --accounts #3,#2 之後全被吃掉。
    expect(posixShellQuote('#3,#2')).toBe("'#3,#2'")
    expect(posixShellQuote('$HOME')).toBe("'$HOME'")
    expect(posixShellQuote('echo "$HOME"')).toBe('\'echo "$HOME"\'')
    expect(posixShellQuote("isn't")).toBe("'isn'\\''t'")
    expect(posixShellQuote('back\\slash')).toBe("'back\\slash'")
    expect(posixShellQuote('multi\nline')).toBe("'multi\nline'")
  })

  // Windows 無 /bin/sh；比照專案慣例跳過（quoting 目標本就是 POSIX shell）。
  it.skipIf(process.platform === 'win32')(
    'posixShellQuote 經真實 /bin/sh round-trip 後位元組一致',
    async () => {
      const { execFileSync } = await import('node:child_process')
      const { existsSync } = await import('node:fs')
      if (!existsSync('/bin/sh')) {
        return
      }
      const samples = [
        '#3,#2',
        '$HOME',
        'echo "$HOME"',
        "isn't",
        'back\\slash',
        'multi\nline',
        'a b  c',
        '`whoami`'
      ]
      for (const sample of samples) {
        const output = execFileSync('/bin/sh', ['-c', `printf '%s' ${posixShellQuote(sample)}`], {
          encoding: 'utf8'
        })
        expect(output).toBe(sample)
      }
    }
  )
})
