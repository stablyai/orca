export type DirectoryLoadRevisions = {
  generation: number
  revisionsByPath: Map<string, number>
}

export type DirectoryLoadToken = {
  generation: number
  relativePath: string
  revision: number
  scope: string
}

export function createDirectoryLoadRevisions(): DirectoryLoadRevisions {
  return { generation: 0, revisionsByPath: new Map() }
}

export function resetDirectoryLoadRevisions(revisions: DirectoryLoadRevisions): void {
  revisions.generation += 1
  revisions.revisionsByPath.clear()
}

export function beginDirectoryLoad(
  revisions: DirectoryLoadRevisions,
  scope: string,
  relativePath: string
): DirectoryLoadToken {
  const revision = (revisions.revisionsByPath.get(relativePath) ?? 0) + 1
  revisions.revisionsByPath.set(relativePath, revision)
  return { generation: revisions.generation, relativePath, revision, scope }
}

export function isCurrentDirectoryLoad(
  revisions: DirectoryLoadRevisions,
  currentScope: string,
  token: DirectoryLoadToken
): boolean {
  return (
    currentScope === token.scope &&
    revisions.generation === token.generation &&
    revisions.revisionsByPath.get(token.relativePath) === token.revision
  )
}
