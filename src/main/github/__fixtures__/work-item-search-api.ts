import { z } from 'zod'

type Captured = { args: string[]; cwd?: string; fixtureCredential?: string }

type Issue = Record<string, unknown>

export class WorkItemSearchApi {
  calls: Captured[] = []
  restSearches = 0
  graphqlCalls = 0
  graphqlFields = 0
  restDetails = 0
  rejected = 0
  graphqlAvailable = true
  searchAvailable = true
  rowsPerRepo = 120
  specialNodes: Issue[] | undefined
  aliasErrorRepo: string | undefined
  expectedSearch: string | undefined
  reportedCount: number | undefined
  private nextCursor = 0
  private cursors = new Map<string, { query: string; offset: number }>()
  private cache = new Map<string, string>()

  private rows(query: string): Issue[] {
    if (this.expectedSearch && query.replace(/ sort:created-desc$/, '') !== this.expectedSearch) {
      throw new Error(`Unexpected fixture search ${query}`)
    }

    const repo = /repo:([^\s]+)/.exec(query)?.[1] ?? 'unknown/repo'

    return (
      this.specialNodes ??
      Array.from({ length: this.rowsPerRepo }, (_, index) => ({
        __typename: 'Issue',
        number: 10000 - index,
        title: `${repo} issue ${index}`,
        state: 'OPEN',
        url: `https://github.com/${repo}/issues/${10000 - index}`,
        updatedAt: '2026-09-11T00:00:00Z',
        author: {
          __typename: 'User',
          login: 'author',
          avatarUrl: 'https://avatars.githubusercontent.com/u/42?u=profile&v=4'
        },
        labels: { nodes: [{ name: 'bug' }], pageInfo: { hasNextPage: false } },
        assignees: { nodes: [], pageInfo: { hasNextPage: false } }
      }))
    )
  }

  async capture(
    _binary: string,
    args: string[],
    options: { cwd?: string; env?: NodeJS.ProcessEnv }
  ): Promise<{ stdout: string; stderr: string }> {
    const credential = options.env?.GH_TOKEN
    this.calls.push({
      args: [...args],
      cwd: options.cwd,
      fixtureCredential: credential?.startsWith('fixture-') ? credential : undefined
    })

    if (args.includes('rate_limit')) {
      const bucket = { limit: 5000, remaining: 4500, reset: 3600 }

      return {
        stdout: JSON.stringify({
          resources: {
            core: bucket,
            graphql: { ...bucket, remaining: this.graphqlAvailable ? 4500 : 0 },
            search: {
              limit: 30,
              remaining: this.searchAvailable ? Math.max(0, 30 - this.restSearches) : 0,
              reset: 60
            }
          }
        }),
        stderr: ''
      }
    }

    if (args[0] === 'pr') {
      return { stdout: '[]', stderr: '' }
    }

    const endpoint = args.find((arg) => arg.startsWith('search/issues?'))

    if (endpoint) {
      const cached = args.includes('--cache')
        ? this.cache.get(JSON.stringify([options.cwd, args]))
        : undefined

      if (cached !== undefined) {
        return { stdout: cached, stderr: '' }
      }

      this.restSearches++

      if (!this.searchAvailable || this.restSearches > 30) {
        this.rejected++
        throw Object.assign(new Error('HTTP 403: API rate limit exceeded'), {
          stderr: 'HTTP 403: API rate limit exceeded'
        })
      }

      const url = new URL(endpoint, 'https://api.github.com')
      const query = url.searchParams.get('q') ?? ''
      const rows = this.rows(query)
      const limit = Number(url.searchParams.get('per_page') ?? 1)
      const page = Number(url.searchParams.get('page') ?? 1)

      if (page * limit > 1000) {
        throw Object.assign(
          new Error('Only the first 1000 search results are available (HTTP 422)'),
          { stderr: 'Only the first 1000 search results are available (HTTP 422)' }
        )
      }

      const stdout = args.includes('.total_count')
        ? String(this.reportedCount ?? rows.length)
        : JSON.stringify(rows.slice((page - 1) * limit, page * limit).map(this.restIssue))

      if (args.includes('--cache')) {
        this.cache.set(JSON.stringify([options.cwd, args]), stdout)
      }

      return { stdout, stderr: '' }
    }

    const detail = args.find((arg) => /^repos\/.+\/issues\/\d+$/.test(arg))

    if (detail) {
      this.restDetails++

      const row = this.rows('repo:fixture/repo').find(
        (row) => row.number === Number(detail.split('/').at(-1))
      )

      return {
        stdout: JSON.stringify({
          ...this.restIssue(row!),
          labels: Array.from({ length: 125 }, (_, index) => ({ name: `label-${index}` }))
        }),
        stderr: ''
      }
    }

    if (!args.includes('graphql')) {
      throw new Error(`Unexpected fixture request ${args.join(' ')}`)
    }

    this.graphqlCalls++

    if (!this.graphqlAvailable) {
      throw Object.assign(new Error('HTTP 403: API rate limit exceeded'), {
        stderr: 'HTTP 403: API rate limit exceeded'
      })
    }

    const query = args.find((arg) => arg.startsWith('query='))?.slice(6) ?? ''

    const fields = [
      ...query.matchAll(
        /(r\d+): search\(type: ISSUE, query: ("(?:[^"\\]|\\.)*"), first: (\d+)(?:, after: ("(?:[^"\\]|\\.)*"))?\)/g
      )
    ]

    if (!fields.length) {
      throw new Error(`Unexpected GraphQL fixture query ${query}`)
    }

    const data: Record<string, unknown> = { rateLimit: { cost: 1 } }
    const errors: unknown[] = []

    for (let index = 0; index < fields.length; index++) {
      const field = fields[index]
      this.graphqlFields++
      const search = z.string().parse(JSON.parse(field[2]))

      if (this.aliasErrorRepo && search.includes(`repo:${this.aliasErrorRepo} `)) {
        data[field[1]] = null
        errors.push({ message: 'fixture repository search unavailable', path: [field[1]] })
        continue
      }

      const first = Number(field[3])
      const cursor = field[4] ? z.string().parse(JSON.parse(field[4])) : undefined
      const saved = cursor ? this.cursors.get(cursor) : undefined

      if (cursor && (!saved || saved.query !== search)) {
        throw new Error('Unknown or cross-query opaque cursor')
      }

      const offset = saved?.offset ?? 0
      const rows = this.rows(search)
      const page = rows.slice(offset, offset + first)
      const next = offset + page.length
      const endCursor = `opaque:${++this.nextCursor}:cursor`
      this.cursors.set(endCursor, { query: search, offset: next })
      const selection = query.slice(field.index, fields[index + 1]?.index ?? query.length)
      data[field[1]] = {
        issueCount: this.reportedCount ?? rows.length,
        pageInfo: { hasNextPage: next < rows.length, endCursor },
        ...(selection.includes(' nodes {') ? { nodes: page } : {})
      }
    }

    const stdout = JSON.stringify({ data, ...(errors.length ? { errors } : {}) })

    if (errors.length) {
      throw Object.assign(new Error('GraphQL partial failure'), {
        stdout,
        stderr: 'GraphQL partial failure'
      })
    }

    return { stdout, stderr: '' }
  }

  private restIssue(row: Issue): Issue {
    const actor = (value: unknown) => {
      const user = z
        .object({
          __typename: z.string().optional(),
          login: z.string(),
          avatarUrl: z.string().optional()
        })
        .nullable()
        .parse(value)

      return user
        ? {
            login: user.login + (user.__typename === 'Bot' ? '[bot]' : ''),
            avatar_url: user.avatarUrl?.replace(/\?u=[^&]+&/, '?')
          }
        : null
    }

    return {
      ...row,
      state: String(row.state).toLowerCase(),
      html_url: row.url,
      updated_at: row.updatedAt,
      user: actor(row.author),
      labels: z.object({ nodes: z.array(z.unknown()) }).parse(row.labels).nodes,
      assignees: z
        .object({ nodes: z.array(z.unknown()) })
        .parse(row.assignees)
        .nodes.map(actor)
    }
  }
}
