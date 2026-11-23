// `run=<link>` on github.workflow_finished: the one GitHub Actions run a wait is for, and the repo it
// is in. Saved as its id beside in=, so `run=<id> in=<repo>` reads back as the same rule.
import { RuntimeClientError } from '../runtime/connection/types'

// https://github.com/<owner>/<repo>/actions/runs/<id>, as the dispatch response (when available) and the run page give
// it; a job's link names its run too.
const RUN_LINK =
  /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/actions\/runs\/(\d{1,20})(\/attempts\/\d+|\/job\/\d+)?\/?(?:[?#].*)?$/i
const RUN_ID = /^\d{1,20}$/

export const RUN_TRIGGER_OPTION =
  '  run=<run link>  github.workflow_finished only, and needed there: the run, as https://github.com/<owner>/<repo>/actions/runs/<id>'

function invalid(message: string): RuntimeClientError {
  return new RuntimeClientError('invalid_argument', message)
}

/**
 * The run a rule waits on, and its repo as in= when the link names it. `places` is in= as written:
 * with a link it may only repeat the link's repo; with a bare id it must name the one repo.
 */
export function parseRunFilter(
  spec: string,
  event: string,
  raw: string | undefined,
  places: readonly string[] | undefined
): { run?: string; in?: string[] } {
  if (raw === undefined) {
    return {}
  }
  if (event !== 'github.workflow_finished') {
    throw invalid(`--on "${spec}": run= is for github.workflow_finished only.`)
  }
  const value = raw.trim()
  if (RUN_ID.test(value)) {
    if (places?.length !== 1) {
      throw invalid(
        `--on "${spec}": run=<id> needs in= to name the run's one repo; or give its link.`
      )
    }
    return { run: value }
  }
  const link = RUN_LINK.exec(value)
  if (!link) {
    throw invalid(
      `--on "${spec}": run= takes the run's link, https://github.com/<owner>/<repo>/actions/runs/<id>.`
    )
  }
  const [, owner = '', repo = '', run = '', tail] = link
  if (tail?.toLowerCase().startsWith('/attempts/')) {
    throw invalid(
      `--on "${spec}": give the run's link without /attempts/: the wait hears the next attempt that finishes and matches its filter.`
    )
  }
  const named = `${owner}/${repo}`.toLowerCase()
  if (places?.length && (places.length !== 1 || places[0]?.toLowerCase() !== named)) {
    throw invalid(`--on "${spec}": the run is in ${named}; leave in= out, the link names its repo.`)
  }
  return { run, in: places?.length ? [...places] : [named] }
}
