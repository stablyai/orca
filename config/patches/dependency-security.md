# Dependency security fixes

These temporary patches cover advisories without a published fixed release.
Replace each patch with an upstream fixed version when available. Raw registry
audits continue to flag the original package versions; the patches do not rewrite
versions or suppress advisories.

| Package          | Advisory            | Mitigation                                                                                                                                                       |
| ---------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| braces 3.0.3     | GHSA-vfj7-8cjw-p6xm | Bound brace and parenthesis nesting and recursive AST walkers to 128 levels. Reject excessive nesting with a controlled SyntaxError before exhausting the stack. |
| sprintf-js 1.1.3 | GHSA-hp3w-g68c-fv3c | Clamp numeric precision to the ECMAScript range before formatting; protect both Node and browser entries.                                                        |

The braces patch applies to mobile, docs tooling, and isolated audit tools.
Desktop no longer installs braces after removing the unused shadcn generator CLI.
The formatting patch applies to desktop and mobile; mobile's older sprintf-js
1.0.3 is first upgraded to 1.1.3.
Mobile patch files stay inside its independent workspace for standalone builds.

`config/scripts/dependency-security-patches.test.mjs` exercises excessive numeric
precision in both installed desktop formatting entries. The mobile regressions in
`mobile/scripts/dependency-security-patches.test.ts` exercise deeply nested brace
and parenthesis patterns and direct AST inputs, then check the installed Expo
RSA dependency (node-forge 1.4.2, fixed upstream) still rejects a signed malformed DigestInfo while accepting a valid
signature. Both suites use the packages installed from the workspace lockfiles;
they do not run installs or access the registry. Normal patterns and formatting
retain their previous behavior. Excessive brace patterns now fail explicitly;
out-of-range numeric precision is clamped instead of throwing a RangeError.

Published fixes are used for node-forge, Hono, Markdown-it, Vite, Vitest, and path-to-regexp.
No development dependency is omitted from the audit.
