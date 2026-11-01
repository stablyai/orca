import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

export type JiraFixtureRequest = {
  url: string
  authorization: string | undefined
  method: string | undefined
}

export async function startJiraAuthFixture(
  respond: (request: JiraFixtureRequest, response: ServerResponse, raw: IncomingMessage) => void
) {
  const requests: JiraFixtureRequest[] = []
  const server = createServer((raw, response) => {
    const header = raw.headers['x-jira-fixture-url']
    const request = {
      url: typeof header === 'string' ? header : '',
      authorization: raw.headers.authorization,
      method: raw.method
    }
    requests.push(request)
    respond(request, response, raw)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Expected a TCP Jira fixture')
  }
  return {
    requests,
    fetch: (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      headers.set('x-jira-fixture-url', url)
      return fetch(`http://127.0.0.1:${address.port}${new URL(url).pathname}`, {
        ...init,
        headers
      })
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        if (!server.listening) {
          resolve()
          return
        }
        server.closeAllConnections()
        server.close((error) =>
          error && error.message !== 'Server is not running.' ? reject(error) : resolve()
        )
      })
  }
}

export function jiraFixtureJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(body))
}
