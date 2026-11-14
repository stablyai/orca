import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export function verifyRequiredPrContext(parseYaml) {
  const directory = '.github/workflows'
  const providers = readdirSync(directory)
    .filter((file) => /\.ya?ml$/.test(file))
    .flatMap((file) => {
      const workflow = parseYaml(readFileSync(join(directory, file), 'utf8'))
      return Object.entries(workflow.jobs)
        .filter(([id, job]) => (job.name ?? id) === 'PR checks passed')
        .map(([id, job]) => ({ owner: `${file}:${id}`, job }))
    })
  const owners = providers.map((provider) => provider.owner)
  if (providers.length !== 1 || owners[0] !== 'pr.yml:verify') {
    throw new Error(`Required PR context must belong only to pr.yml:verify; found ${owners}`)
  }
  const gate = providers[0].job
  const condition = gate.if?.replace(/^\$\{\{\s*|\s*\}\}$/g, '').trim()
  if (condition !== '!cancelled() && github.event.pull_request.draft != true') {
    throw new Error('Required PR aggregate must run unless cancelled or the PR is a draft.')
  }
  if (gate['continue-on-error'] || gate.steps?.some((step) => step['continue-on-error'])) {
    throw new Error('Required PR aggregate must not ignore failures.')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const yaml = globalThis.Bun?.YAML
  if (!yaml) {
    throw new Error('Run workflow context validation with the pinned Bun runtime.')
  }
  verifyRequiredPrContext(yaml.parse)
  console.log('Required PR check context verified.')
}
