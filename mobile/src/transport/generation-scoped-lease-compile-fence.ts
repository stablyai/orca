import {
  GenerationScopedRequestOwner,
  type RequestLease,
  type RequestScope
} from './generation-scoped-request-owner'

// Why this file exists: the owner's claim is that a caller cannot publish into it except through a
// lease it issued, in the generation it issued it. Every expect-error directive below is that claim
// as an assertion — tsc fails on a directive that stops catching an error, so
// `pnpm --dir mobile typecheck` is the gate. `mobile/tsconfig.json` excludes tests, so a type-level
// assertion written in one is checked by nothing; that is why these live here. Nothing here runs.

type FileParameters = { readonly query: string }

declare const scope: RequestScope
declare const host: object
declare const epoch: bigint
declare const label: symbol
declare const paths: GenerationScopedRequestOwner<FileParameters, string[]>
declare const counts: GenerationScopedRequestOwner<FileParameters, number>
declare const pathLease: RequestLease<string[]>
declare const countLease: RequestLease<number>

// @ts-expect-error the brand is module-private, so no caller can mint a lease
export const fenceForgedLease: RequestLease<string[]> = {}

// @ts-expect-error a lease is invariant in its value, so two owners' leases are not interchangeable
export const fenceSwappedLease: RequestLease<string[]> = countLease

export function fenceCommitTakesItsOwnLease(): void {
  // @ts-expect-error the value must be the one this owner publishes
  paths.commit(pathLease, 42)
  // @ts-expect-error a peer owner's lease is not this owner's to commit
  paths.commit(countLease, ['a'])
  counts.commit(countLease, 42)
}

export function fenceParametersAreOwnerTyped(): void {
  // @ts-expect-error the parameters are the owner's declared type, not a caller-chosen key
  paths.read(scope, 'files.list:A')
  // @ts-expect-error a missing declared parameter is not a key the owner can build
  paths.read(scope, {})
  paths.read(scope, { query: 'a' })
}

export function fenceScopeMembersAreEncodable(): void {
  // @ts-expect-error a symbol has no encoding here that is both stable and collision-free
  void paths.read([host, label], { query: 'a' })
  // @ts-expect-error a bigint is not serialisable, so it cannot identify a scope
  void paths.read([host, epoch], { query: 'a' })
  void paths.read([host, 'w1', 2], { query: 'a' })
}

export function fenceLoaderOnlyReturns(): void {
  // @ts-expect-error the loader publishes by returning the owner's value, not some other type
  void paths.load(scope, { query: 'a' }, async () => 'not-a-path-list')
  void paths.load(scope, { query: 'a' }, async () => null)
}

// @ts-expect-error the lease carries its generation privately; a caller cannot read or compare it
export const fenceLeaseGenerationUnreadable: number = pathLease.generation
