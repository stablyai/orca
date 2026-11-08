/** Add every in-tree `.gitattributes` Git consults for a repo-relative path: the root one and each ancestor's. */
export function addGitattributesStampPaths(target: Set<string>, repoPath: string): void {
  target.add('.gitattributes')
  for (let end = repoPath.indexOf('/'); end !== -1; end = repoPath.indexOf('/', end + 1)) {
    target.add(`${repoPath.slice(0, end)}/.gitattributes`)
  }
}
