// Why: the RPC boundary ingests loosely-typed JSON from a CLI that grew
// organically, so these reusable pieces capture the validation shapes that
// recur across domains (optional worktree selector, bounded limit, browser
// target envelope, etc.). Methods compose these to declare their real
// contract without repeating the same `typeof` gymnastics 90 times.
export {
  BrowserTarget,
  OptionalBoolean,
  OptionalFiniteNumber,
  OptionalPlainString,
  OptionalPositiveInt,
  OptionalString,
  TriStateLinkedIssue,
  requiredNumber,
  requiredString,
  requiredStringAllowingEmpty
} from '../../../shared/rpc-contract/rpc-param-primitives'
