import { publishBots } from '@/lib/bot-catalog-snapshot'
import type { Bot } from '../../../shared/bot-types'
import { createCompatibleRuntimeStatusResponse } from '@/runtime/rpc/testing/runtime-compatibility-test-fixture'

// The bot reads a mounted bot list makes, answered without a runtime: these bots, no groups, nothing new.
export function stubBots(bots: Bot[]): void {
  publishBots(bots)
  const results: Record<string, unknown> = {
    'bots.list': { bots },
    'bots.groups.list': { groups: [] },
    'bots.upNext.unseen': { unseen: {} },
    'bots.chatTree': { chats: [], workspaceChats: {} }
  }
  const runtime: unknown = window.api.runtime
  Reflect.set(window.api, 'runtime', {
    ...(typeof runtime === 'object' ? runtime : {}),
    call: async ({ method }: { method: string }) =>
      method in results
        ? { ok: true, result: results[method] }
        : { ok: false, error: { code: 'runtime_error', message: method } }
  })
}

/**
 * Paired servers' bot reads, answered without a runtime: each server lists its bots, and every
 * server is as new as this app. A server left out of `byServer` answers as unreachable. `souls`,
 * by bot id, is each server bot's SOUL.md as its own server reads it.
 */
export function stubServerBots(
  byServer: Record<string, Bot[]>,
  souls: Record<string, string> = {}
): void {
  const environments: unknown = window.api.runtimeEnvironments
  Reflect.set(window.api, 'runtimeEnvironments', {
    ...(typeof environments === 'object' ? environments : {}),
    call: async ({
      selector,
      method,
      params
    }: {
      selector: string
      method: string
      params?: { worktree?: string; relativePath?: string }
    }) => {
      const bots = byServer[selector]
      if (!bots) {
        return { ok: false, error: { code: 'runtime_unavailable', message: selector } }
      }
      const soulOf = bots.find(
        (bot) => souls[bot.id] && params?.worktree?.endsWith(bot.folderWorkspaceId)
      )
      if (method === 'files.read' && params?.relativePath === 'SOUL.md' && soulOf) {
        return { ok: true, result: { content: souls[soulOf.id], isBinary: false } }
      }
      const results: Record<string, unknown> = {
        'status.get': createCompatibleRuntimeStatusResponse(selector).result,
        'bots.list': { bots },
        'bots.groups.list': { groups: [] },
        'bots.upNext.unseen': { unseen: {} },
        'bots.chatTree': { chats: [], workspaceChats: {} }
      }
      return method in results
        ? { ok: true, result: results[method] }
        : { ok: false, error: { code: 'runtime_error', message: method } }
    }
  })
}
