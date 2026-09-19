#!/usr/bin/env node

// Pushes the release cut's refs, tolerating the one rejection GitHub returns
// for a reason that has nothing to do with this push.
//
// `GITHUB_TOKEN` can never hold `workflow` scope, so every push from the cut
// depends on GitHub deciding, server-side, that the push modifies no
// `.github/workflows/` file. Creating a *new* tag ref makes that check walk
// reachability against every existing ref, and this repo carries >26k of them.
// Past a size threshold the check times out, and GitHub fails closed with a
// permission-shaped message for what is really a timeout — on a push that only
// ever carries package.json and the skill release-mapping row. Three
// consecutive v1.4.198 cuts died this way on 2026-09-08.
//
// Setting the RELEASE_PUSH_TOKEN secret to a token that does hold `workflow`
// scope skips GitHub's determination entirely and makes this retry dead code.

import { execFile } from 'node:child_process'

export const WORKFLOW_SCOPE_REJECTION = 'workflows` scope may be required'

export function isWorkflowScopeTimeout(output) {
  return output.includes(WORKFLOW_SCOPE_REJECTION)
}

export function recoveryRunbook(ref, sha) {
  return (
    `Could not push ${ref}: GitHub could not determine whether the push modifies ` +
    '.github/workflows and failed closed. This is a timeout, not a real permission ' +
    'problem. Set the RELEASE_PUSH_TOKEN secret to a token with `workflow` scope to ' +
    `fix it permanently. To recover this cut now, push ${ref} (at ${sha}) from a ` +
    'workflow-scoped credential and re-dispatch this workflow — orphan-tag recovery ' +
    'adopts the existing tag and runs the release build against it. Re-dispatch, do ' +
    'not re-run: a re-run makes the Windows job skip its artifact build.'
  )
}

/**
 * Retries ONLY the workflow-scope timeout. Any other push failure is real and
 * surfaces on the first attempt rather than being retried three times.
 */
export async function pushRef(ref, { push, attempts = 3, onRetry = () => {}, wait }) {
  let lastOutput = ''
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const { ok, output } = await push(ref)
    lastOutput = output
    if (ok) {
      return { ok: true, attempts: attempt }
    }
    if (!isWorkflowScopeTimeout(output)) {
      return { ok: false, attempts: attempt, output, workflowScopeTimeout: false }
    }
    if (attempt < attempts) {
      onRetry(attempt, attempts)
      await wait(attempt)
    }
  }
  return { ok: false, attempts, output: lastOutput, workflowScopeTimeout: true }
}

function gitPush(ref) {
  return new Promise((resolve) => {
    execFile('git', ['push', 'origin', ref], (error, stdout, stderr) => {
      const output = `${stdout}${stderr}`
      process.stdout.write(output)
      resolve({ ok: error === null, output })
    })
  })
}

async function main() {
  const tag = process.env.TAG
  const sha = process.env.SHA ?? 'the release commit'
  if (!tag) {
    console.error('::error::TAG is required')
    process.exit(1)
  }

  // Fast-forward main first so developers see the right version locally; an
  // off-main release publishes only the tag and leaves main untouched.
  const refs = process.env.PUSH_MAIN === 'true' ? ['HEAD:refs/heads/main', tag] : [tag]

  for (const ref of refs) {
    const result = await pushRef(ref, {
      push: gitPush,
      onRetry: (attempt, attempts) =>
        console.log(
          `::warning::Push of ${ref} hit GitHub's workflow-scope determination ` +
            `timeout (attempt ${attempt}/${attempts}); retrying.`
        ),
      wait: (attempt) => new Promise((resolve) => setTimeout(resolve, attempt * 15_000))
    })
    if (!result.ok) {
      console.error(
        result.workflowScopeTimeout
          ? `::error::${recoveryRunbook(ref, sha)}`
          : `::error::Failed to push ${ref}.`
      )
      process.exit(1)
    }
  }
}

// Why the guard: the module is imported by its test, which must not push.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  await main()
}
