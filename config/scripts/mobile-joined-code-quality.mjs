import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { parseOxlintOutput, resolveOxlintInvocation } from './oxlint-cli-invocation.mjs'
import {
  MOBILE_JOINED_PROJECT,
  parseTypecheckOptions,
  resolveTypecheckBunExecutable,
  runMobileHostTypecheck,
  selectTypecheckCompiler
} from './run-typecheck-projects-in-parallel.mjs'

export function partitionMobileJoinedFiles(root, files) {
  const config = JSON.parse(readFileSync(path.join(root, MOBILE_JOINED_PROJECT), 'utf8'))
  const roots = config.files
    .filter((file) => /\.test\.[cm]?[jt]sx?$/.test(file))
    .map((file) =>
      path
        .relative(root, path.resolve(root, path.dirname(MOBILE_JOINED_PROJECT), file))
        .split(path.sep)
        .join('/')
    )
  if (
    roots.length !== 3 ||
    new Set(roots).size !== 3 ||
    roots.some((file) => !file.startsWith('mobile/'))
  ) {
    throw new Error('Expected the three complete Mobile joined test roots')
  }
  const joinedRoots = new Set(roots)
  const joined = files.filter((file) => joinedRoots.has(file))
  const rest = files.filter((file) => !joinedRoots.has(file))
  if (new Set([...rest, ...joined]).size !== files.length) {
    throw new Error('Mobile analyzer partitions must be a disjoint union of changed files')
  }
  return { joined, rest }
}

export async function runMobileJoinedOxlintScan(root, scan, files) {
  if (files.length === 0) {
    throw new Error('Mobile joined analyzer requires literal test files')
  }
  const options = parseTypecheckOptions([
    '--compiler=bun',
    '--bun-threads=2',
    '--project=mobile/tsconfig.json',
    `--project=${MOBILE_JOINED_PROJECT}`,
    '--mobile-host-declarations'
  ])
  const selection = selectTypecheckCompiler(options.compiler, {
    root,
    resolveBunExecutable: resolveTypecheckBunExecutable
  })
  let diagnostics
  const failures = await runMobileHostTypecheck({
    ...options,
    ...selection,
    root,
    consumeDeclarations: async ({ runOwnedProcess, signal }) => {
      const { command, prefixArgs } = resolveOxlintInvocation(root)
      const args = [
        ...prefixArgs,
        ...scan.args,
        '--tsconfig',
        MOBILE_JOINED_PROJECT,
        '--format',
        'json',
        ...files
      ]
      console.log(
        `Mobile joined analyzer: ${JSON.stringify({
          phase: 'start',
          command,
          args,
          configSha256: createHash('sha256')
            .update(readFileSync(path.join(root, MOBILE_JOINED_PROJECT)))
            .digest('hex')
        })}`
      )
      const result = await runOwnedProcess({
        program: command,
        args,
        cwd: root,
        stdio: 'pipe',
        maxOutputBytes: 128 * 1024 * 1024,
        killOnOutputLimit: true
      })
      console.log(
        `Mobile joined analyzer: ${JSON.stringify({
          phase: 'end',
          code: result.code,
          signal: result.signal,
          timedOut: result.timedOut,
          outputTruncated: result.outputTruncated ?? false
        })}`
      )
      if (
        signal.aborted ||
        result.signal ||
        result.timedOut ||
        result.outputTruncated ||
        ![0, 1].includes(result.code)
      ) {
        throw new Error('Mobile joined analyzer did not complete with intact diagnostics')
      }
      const parsed = parseOxlintOutput(result.stdout, scan.label)
      if (
        !Array.isArray(parsed.diagnostics) ||
        (result.code !== 0 && parsed.diagnostics.length === 0)
      ) {
        throw new Error(
          'Mobile joined analyzer returned no valid diagnostic array for its exit status'
        )
      }
      console.log(`Mobile joined analyzer raw JSON: ${result.stdout}`)
      if (result.stderr) {
        process.stderr.write(result.stderr)
      }
      diagnostics = parsed.diagnostics
    }
  })
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Mobile joined analyzer infrastructure failed')
  }
  if (!diagnostics) {
    throw new Error('Mobile joined analyzer was not completed')
  }
  return diagnostics
}
