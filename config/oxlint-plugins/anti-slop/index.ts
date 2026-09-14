import { eslintCompatPlugin } from '@oxlint/plugins'

import { noArrayFilterMapRule } from './rules/no-array-filter-map.ts'
import { noCallOnlyAssertionsRule } from './rules/no-call-only-assertions.ts'
import { noChainedTypeAssertionsRule } from './rules/no-chained-type-assertions.ts'
import { noConditionalEmptyObjectSpreadRule } from './rules/no-conditional-empty-object-spread.ts'
import { noKnownValueWideningRule } from './rules/no-known-value-widening.ts'
import { noModuleMockingRule } from './rules/no-module-mocking.ts'
import { noObjectParametersRule } from './rules/no-object-parameters.ts'
import { noPassThroughTypeAliasRule } from './rules/no-pass-through-type-alias.ts'
import { noReduceAccumulatorCopyRule } from './rules/no-reduce-accumulator-copy.ts'
import { noReflectApplyRule } from './rules/no-reflect-apply.ts'
import { noReflectGetRule } from './rules/no-reflect-get.ts'
import { noRuntimeTypeofRule } from './rules/no-runtime-typeof.ts'
import { noForbiddenTermInSymbolNamesRule } from './rules/no-shape-in-symbol-names.ts'
import { noUnknownParametersRule } from './rules/no-unknown-parameters.ts'
import { noUnknownReturnsRule } from './rules/no-unknown-returns.ts'
import { noUnknownTypeAliasesRule } from './rules/no-unknown-type-aliases.ts'
import { noUnsafeDictionaryTypeRule } from './rules/no-unsafe-dictionary-type.ts'
import { noWidenThenAssertRule } from './rules/no-widen-then-assert.ts'
import { requireReadableSpacingRule } from './rules/require-readable-spacing.ts'
import { requireSafetyCommentForTypeAssertionRule } from './rules/require-safety-comment-for-type-assertion.ts'

/** Vendored from dmmulroy/anti-slop (MIT) plus two rules from maharshi365/deslop (MIT). */
export default eslintCompatPlugin({
  meta: { name: 'anti-slop' },
  rules: {
    'no-array-filter-map': noArrayFilterMapRule,
    'no-call-only-assertions': noCallOnlyAssertionsRule,
    'no-chained-type-assertions': noChainedTypeAssertionsRule,
    'no-conditional-empty-object-spread': noConditionalEmptyObjectSpreadRule,
    'no-known-value-widening': noKnownValueWideningRule,
    'no-module-mocking': noModuleMockingRule,
    'no-object-parameters': noObjectParametersRule,
    'no-pass-through-type-alias': noPassThroughTypeAliasRule,
    'no-reduce-accumulator-copy': noReduceAccumulatorCopyRule,
    'no-reflect-apply': noReflectApplyRule,
    'no-reflect-get': noReflectGetRule,
    'no-runtime-typeof': noRuntimeTypeofRule,
    'no-shape-in-symbol-names': noForbiddenTermInSymbolNamesRule,
    'no-unknown-parameters': noUnknownParametersRule,
    'no-unknown-returns': noUnknownReturnsRule,
    'no-unknown-type-aliases': noUnknownTypeAliasesRule,
    'no-unsafe-dictionary-type': noUnsafeDictionaryTypeRule,
    'no-widen-then-assert': noWidenThenAssertRule,
    'require-readable-spacing': requireReadableSpacingRule,
    'require-safety-comment-for-type-assertion': requireSafetyCommentForTypeAssertionRule,
  },
})
