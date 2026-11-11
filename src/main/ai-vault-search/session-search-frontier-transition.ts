import type { SessionSearchCatalog } from './session-search-catalog'

export type SessionSearchFrontierCommand =
  | { kind: 'frontier-snapshot'; scope: string }
  | {
      kind: 'frontier-settle'
      scope: string
      target: string
      cutoff: number
      rows: { key: string; revision?: number; outcome?: 'retry' | 'parked' }[]
    }
  | { kind: 'frontier-set'; scope: string; key: string; value: string }
  | { kind: 'frontier-set-page'; scope: string; rows: { key: string; value: string }[] }
  | { kind: 'frontier-move'; scope: string; target: string }
  | { kind: 'frontier-wake'; scope: string }
  | { kind: 'frontier-ack'; scope: string; receipts: { key: string; revision: number }[] }
  | { kind: 'ack-values'; scope: string; rows: { key: string; value: string }[] }

export function transitionSessionSearchFrontier(
  catalog: SessionSearchCatalog,
  command: SessionSearchFrontierCommand
) {
  if (command.kind === 'frontier-snapshot') {
    return { revision: catalog.nextRevision() }
  }
  if (command.kind === 'frontier-settle') {
    catalog.connection.exec('SAVEPOINT search_frontier_settle')
    try {
      for (const item of command.rows) {
        const { key } = item
        const current = catalog.execute({ kind: 'get', scope: command.scope, key }).rows?.[0]
        if (
          item.revision !== undefined
            ? current?.tie !== item.revision
            : (current?.tie ?? 0) > command.cutoff
        ) {
          continue
        }
        if (item.outcome) {
          const target = item.outcome === 'parked' ? command.target : command.scope
          const newer =
            target === command.scope
              ? current
              : catalog.execute({ kind: 'get', scope: target, key }).rows?.[0]
          if ((newer?.tie ?? 0) <= command.cutoff) {
            transitionSessionSearchFrontier(catalog, {
              kind: 'frontier-set',
              scope: target,
              key,
              value: JSON.stringify(key)
            })
          }
        }
        if (item.revision !== undefined && item.outcome !== 'retry') {
          catalog.execute({ kind: 'delete', scope: command.scope, key })
        }
      }
      catalog.connection.exec('RELEASE search_frontier_settle')
      return {}
    } catch (error) {
      catalog.connection.exec('ROLLBACK TO search_frontier_settle; RELEASE search_frontier_settle')
      throw error
    }
  }
  const wakeScope = `${command.scope}:wake`
  if (command.kind === 'ack-values' || command.kind === 'frontier-ack') {
    const items =
      command.kind === 'ack-values'
        ? command.rows.map((item) => ({
            key: item.key,
            matches: (row: { value: string; tie?: number }) => row.value === item.value
          }))
        : command.receipts.map((item) => ({
            key: item.key,
            matches: (row: { value: string; tie?: number }) => row.tie === item.revision
          }))
    for (const item of items) {
      const row = catalog.execute({ kind: 'get', scope: command.scope, key: item.key }).rows?.[0]
      if (row && item.matches(row)) {
        catalog.execute({ kind: 'delete', scope: command.scope, key: item.key })
      }
    }
    return {}
  }
  if (command.kind === 'frontier-wake') {
    catalog.execute({
      kind: 'put',
      scope: wakeScope,
      rows: [
        {
          key: 'active',
          value: String(catalog.nextRevision()),
          parent: '',
          group: '',
          rank: 0,
          ready: 1
        }
      ]
    })
    return {}
  }
  if (command.kind === 'frontier-move') {
    const wake = catalog.execute({ kind: 'get', scope: wakeScope, key: 'active' }).rows?.[0]
    if (!wake) {
      return {}
    }
    const page = catalog.execute({
      kind: 'page',
      scope: command.scope,
      group: '',
      throughRevision: Number(wake.value),
      orderRevision: true
    })
    for (const row of page.rows ?? []) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this frontier encoded the matching value wrapper.
      const value = JSON.parse(row.value) as { value: unknown }
      catalog.execute({
        kind: 'frontier-set',
        scope: command.target,
        key: row.key,
        value: JSON.stringify(value.value)
      })
    }
    catalog.execute({
      kind: 'delete-page',
      scope: command.scope,
      keys: (page.rows ?? []).map((row) => row.key)
    })
    if (
      !catalog.execute({
        kind: 'page',
        scope: command.scope,
        group: '',
        throughRevision: Number(wake.value),
        orderRevision: true,
        limit: 1
      }).rows?.length
    ) {
      catalog.execute({ kind: 'delete', scope: wakeScope, key: 'active' })
    }
    return {}
  }
  const rows = command.kind === 'frontier-set' ? [command] : command.rows
  for (const item of rows) {
    const row = catalog.execute({ kind: 'get', scope: command.scope, key: item.key }).rows?.[0]
    // Reuse the writer's indexed tail instead of projecting all queued entries.
    const order = row?.rank ?? catalog.frontierOrder(command.scope)
    const revision = catalog.nextRevision()
    catalog.execute({
      kind: 'put',
      scope: command.scope,
      rows: [
        {
          key: item.key,
          value: JSON.stringify({
            value: JSON.parse(item.value),
            order,
            revision
          }),
          parent: '',
          group: '',
          rank: order,
          tie: revision,
          ready: 0
        }
      ]
    })
  }
  return {}
}
