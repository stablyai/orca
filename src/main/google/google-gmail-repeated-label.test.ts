import { expect, it } from 'vitest'
import { googleApi, EMAIL, NOW } from './google-api-http.test-fixture'

const { modifyGmail } = await import('./google-gmail-write')

it('creates a repeated new label once and applies it alongside existing labels', async () => {
  const labels = [{ id: 'Label_existing', name: 'Existing', type: 'user' }]
  let applied: unknown
  const api = await googleApi(EMAIL, {
    now: () => NOW,
    http: async (input, options) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/labels') && options?.method === 'GET') {
        return Response.json({ labels })
      }
      if (url.pathname.endsWith('/labels')) {
        const body: { name: string } = JSON.parse(String(options?.body))
        if (labels.some((label) => label.name.toLowerCase() === body.name.toLowerCase())) {
          return Response.json(
            { error: { message: 'Label name exists or conflicts' } },
            { status: 409 }
          )
        }
        const label = { id: 'Label_project', name: body.name, type: 'user' }
        labels.push(label)
        return Response.json(label)
      }
      if (url.pathname.endsWith('/messages/batchModify')) {
        const body: { addLabelIds: string[] } = JSON.parse(String(options?.body))
        applied = [...new Set(body.addLabelIds)]
        return new Response(null, { status: 204 })
      }
      throw new Error(`Unexpected Gmail URL: ${url}`)
    }
  })

  const result = await modifyGmail(api, {
    refs: ['gmail:msg:1234567890abcdef'],
    add: ['Project', ' Project ', 'Existing'],
    remove: []
  })
  expect(result.created).toEqual(['Project'])
  expect(applied).toEqual(['Label_project', 'Label_existing'])
  expect(labels).toEqual([
    { id: 'Label_existing', name: 'Existing', type: 'user' },
    { id: 'Label_project', name: 'Project', type: 'user' }
  ])
})
