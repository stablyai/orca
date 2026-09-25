export { evaluateScope } from './diff-scope-check.ts';
export type { ScopeCheckInput, ScopeVerdict } from './diff-scope-check.ts';
export {
  listCommittedChanges,
  listUncommittedChanges,
  parseNulSeparatedPaths,
  parsePorcelainPaths,
  runGitWithExecFile
} from './git-changed-files.ts';
export type { GitRunner } from './git-changed-files.ts';
export { createScopeMatcher } from './scope-matcher.ts';
export { MAX_SCOPE_LINES, parseScopeList } from './scope-list-parser.ts';
export type { ScopeParseResult, ScopeProblem, ScopeProblemCode } from './scope-list-parser.ts';
export { findUnsafeReason, normalizeRepoPath } from './scope-path.ts';
export type { UnsafePathReason } from './scope-path.ts';
