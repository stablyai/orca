import { appendFileSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { isDocsOnlyPath } from './pr-code-change-scope.mjs'

const APPLICATION_PREFIXES = ['src/', 'mobile/app/', 'mobile/src/']

export function shouldRunMobileReleaseChecks(files) {
  return (
    files.length === 0 ||
    files.some(
      (file) =>
        !isDocsOnlyPath(file) &&
        file !== 'mobile/README.md' &&
        !file.startsWith('mobile/docs/') &&
        !(
          APPLICATION_PREFIXES.some((prefix) => file.startsWith(prefix)) &&
          /\.(?:[cm]?[jt]sx?|css|md)$/.test(file)
        )
    )
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const input = readFileSync(process.argv[2], 'utf8')
  const files = input.endsWith('\0') ? input.slice(0, -1).split('\0') : []
  const shouldRun = shouldRunMobileReleaseChecks(files)
  console.log(
    shouldRun ? 'Checking Ruby release inputs.' : 'Only application or documentation changed.'
  )
  appendFileSync(process.env.GITHUB_OUTPUT, `should_run=${shouldRun}\n`)
}
