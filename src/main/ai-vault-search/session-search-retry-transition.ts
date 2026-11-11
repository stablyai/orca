import { admitSessionSearchPrimaryFailures } from './session-search-primary-retries'
import { wakeSessionSearchPrimaryFailures } from './session-search-dirty-transition'
import { isInsideSessionRoot } from '../ai-vault/session-file-discovery'
import { relative } from 'node:path'
import { SESSION_INPUT_FAILURES_BEFORE_HELD_OUT } from '../ai-vault/session-observation-retries'
import type { AiVaultScanIssue } from '../../shared/ai-vault/contracts/ai-vault-types'
import type { SessionSearchCatalog } from './session-search-catalog'
import {
  authorityRow,
  authorityValue,
  putAuthorityValue,
  rearmSessionSearchAuthority
} from './session-search-observation-authority'
import { invalidateSessionSearchPhysical } from './session-search-dirty-transition'

export type SessionSearchRetryDebt = {
  failures: number
  attempted: number
  force: boolean
  metadata?: boolean
  issue?: AiVaultScanIssue
}
export type SessionSearchRetryCommand =
  | {
      kind: 'retry-fail'
      scope: string
      path: string
      generation: number
      force: boolean
      issue?: AiVaultScanIssue
    }
  | { kind: 'retry-remove'; scope: string; path: string }
  | { kind: 'retry-require'; scope: string; path: string }
  | { kind: 'retry-wake'; scope: string; prefix?: string; all?: boolean }
  | { kind: 'retry-admit'; scope: string; root: string; generation: number; primary?: boolean }

export function recordSessionSearchRetry(
  catalog: SessionSearchCatalog,
  scope: string,
  path: string,
  debt?: SessionSearchRetryDebt,
  revision?: number
): void {
  const eligible = `${scope}:eligible`
  if (!debt) {
    catalog.execute({ kind: 'delete', scope, key: path })
    catalog.execute({ kind: 'delete', scope: eligible, key: path })
    return
  }
  const nextRevision = revision ?? catalog.nextRevision()
  catalog.execute({
    kind: 'put',
    scope,
    rows: [
      {
        key: path,
        value: JSON.stringify(debt),
        parent: '',
        group: debt.issue ? 'issue' : '',
        rank: 0,
        tie: nextRevision,
        ready: Number(debt.failures < SESSION_INPUT_FAILURES_BEFORE_HELD_OUT)
      }
    ]
  })
  if (debt.failures < SESSION_INPUT_FAILURES_BEFORE_HELD_OUT) {
    putAuthorityValue(catalog, eligible, path, true, debt.attempted + 1)
  } else {
    catalog.execute({ kind: 'delete', scope: eligible, key: path })
  }
}

function admit(
  catalog: SessionSearchCatalog,
  owner: string,
  scope: string,
  root: string,
  generation: number,
  directory: boolean
): void {
  const wakes = `${scope}:wakes`
  const wake = catalog.execute({ kind: 'page', scope: wakes, limit: 1 }).rows?.[0]
  if (wake) {
    const value = authorityValue<{ prefix?: string; cutoff: number; after?: string }>(wake)!
    const page = catalog.execute({
      kind: 'page',
      scope,
      prefix: value.prefix,
      after: value.after,
      limit: 64
    })
    for (const row of page.rows ?? []) {
      if (
        (row.tie ?? 0) > value.cutoff ||
        (value.prefix !== undefined && !isInsideSessionRoot(value.prefix, row.key))
      ) {
        continue
      }
      const debt = authorityValue<SessionSearchRetryDebt>(row)!
      recordSessionSearchRetry(catalog, scope, row.key, {
        ...debt,
        failures: 0,
        attempted: generation - 1
      })
    }
    if (page.after) {
      putAuthorityValue(catalog, wakes, wake.key, { ...value, after: page.after }, 0, 1)
    } else {
      catalog.execute({ kind: 'delete', scope: wakes, key: wake.key })
    }
  }
  const eligible = `${scope}:eligible`
  const page = catalog.execute({
    kind: 'page',
    scope: eligible,
    group: '',
    orderRank: true,
    beforeRank: generation,
    limit: 64
  })
  for (const row of page.rows ?? []) {
    const debt = authorityValue<SessionSearchRetryDebt>(authorityRow(catalog, scope, row.key))
    if (
      debt &&
      debt.failures < SESSION_INPUT_FAILURES_BEFORE_HELD_OUT &&
      debt.attempted !== generation
    ) {
      if (directory) {
        if (!authorityRow(catalog, `${owner}:walks`, row.key)) {
          catalog.execute({
            kind: 'directory-schedule',
            scope: owner,
            path: row.key,
            depth: relative(root, row.key).split(/[\\/]/).filter(Boolean).length,
            reconcile: true
          })
        }
      } else if (
        !authorityRow(catalog, `${owner}:dirty`, row.key) &&
        !authorityRow(catalog, `${owner}:observing`, row.key)
      ) {
        invalidateSessionSearchPhysical(catalog, owner, row.key, debt.force, false)
      }
    }
    catalog.execute({ kind: 'delete', scope: eligible, key: row.key })
  }
}

export function transitionSessionSearchRetry(
  catalog: SessionSearchCatalog,
  command: SessionSearchRetryCommand
) {
  if (command.kind === 'retry-admit') {
    if (command.primary !== false) {
      admitSessionSearchPrimaryFailures(catalog, command.scope)
    }
    admit(
      catalog,
      command.scope,
      `${command.scope}:refusals`,
      command.root,
      command.generation,
      true
    )
    admit(
      catalog,
      command.scope,
      `${command.scope}:file-refusals`,
      command.root,
      command.generation,
      false
    )
    return {}
  }
  if (command.kind === 'retry-wake') {
    if (command.all && command.prefix) {
      for (const suffix of ['primary-wakes', 'refusals', 'file-refusals']) {
        catalog.execute({
          kind: 'retry-wake',
          scope: `${command.scope}:${suffix}`,
          prefix: command.prefix
        })
      }
      return {}
    }
    if (command.scope.endsWith(':primary-wakes') && command.prefix) {
      wakeSessionSearchPrimaryFailures(
        catalog,
        command.scope.slice(0, -':primary-wakes'.length),
        command.prefix
      )
      return {}
    }
    if (
      !catalog.execute({ kind: 'page', scope: command.scope, prefix: command.prefix, limit: 1 })
        .rows?.length
    ) {
      return {}
    }
    const cutoff = catalog.nextRevision()
    putAuthorityValue(
      catalog,
      `${command.scope}:wakes`,
      command.prefix ?? '@root',
      { prefix: command.prefix, cutoff },
      0,
      1
    )
    return {}
  }
  const row = authorityRow(catalog, command.scope, command.path)
  const previous = authorityValue<SessionSearchRetryDebt>(row)
  if (command.kind === 'retry-remove') {
    recordSessionSearchRetry(catalog, command.scope, command.path)
    const owner = command.scope.slice(0, command.scope.lastIndexOf(':'))
    rearmSessionSearchAuthority(catalog, owner, command.path)
  } else if (command.kind === 'retry-require') {
    if (row && previous && !previous.force) {
      catalog.execute({
        kind: 'put',
        scope: command.scope,
        rows: [{ ...row, value: JSON.stringify({ ...previous, force: true }) }]
      })
    }
  } else if (previous?.attempted !== command.generation) {
    recordSessionSearchRetry(catalog, command.scope, command.path, {
      failures: (previous?.failures ?? 0) + 1,
      attempted: command.generation,
      force: command.force || (previous?.force ?? false),
      issue: command.issue ?? previous?.issue
    })
  }
  return {}
}
