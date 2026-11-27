import { expect, it } from 'vitest'
import { googleApi, EMAIL, NOW } from './google-api-http.test-fixture'

const { makeFolder } = await import('./google-drive')
const FOLDER = 'application/vnd.google-apps.folder'

it('refuses a parent name duplicated after an empty continuation page before writing', async () => {
  let singlePage = false
  const parents: string[][] = []
  const api = await googleApi(EMAIL, {
    now: () => NOW,
    http: async (input, options) => {
      if (options?.method === 'POST') {
        const body: { parents: string[] } = JSON.parse(String(options.body))
        parents.push(body.parents)
        return Response.json({ id: 'created', name: 'Child', mimeType: FOLDER })
      }
      const token = new URL(String(input)).searchParams.get('pageToken')
      return Response.json(
        singlePage
          ? { files: [{ id: 'one', name: 'Project' }] }
          : token === 'last'
            ? { files: [{ id: 'two', name: 'Project' }] }
            : token === 'empty'
              ? { files: [], nextPageToken: 'last' }
              : { files: [{ id: 'one', name: 'Project' }], nextPageToken: 'empty' }
      )
    }
  })

  await expect(makeFolder(api, { name: 'Child', in: 'Project' })).rejects.toThrow(
    'Several folders are named'
  )
  expect(parents).toEqual([])

  singlePage = true
  expect((await makeFolder(api, { name: 'Child', in: 'Project' })).folder).toEqual({
    id: 'one',
    name: 'Project'
  })
  expect(parents).toEqual([['one']])
})

it('refuses incomplete name searches while keeping explicit folder ids and root usable', async () => {
  const knownId = 'folder_known_1234567890'
  const parents: string[][] = []
  const api = await googleApi(EMAIL, {
    now: () => NOW,
    http: async (input, options) => {
      if (options?.method === 'POST') {
        const body: { parents: string[] } = JSON.parse(String(options.body))
        parents.push(body.parents)
        return Response.json({ id: 'created', name: 'Child', mimeType: FOLDER })
      }
      if (new URL(String(input)).pathname.endsWith(knownId)) {
        return Response.json({ id: knownId, name: 'Project', mimeType: FOLDER })
      }
      return Response.json({
        files: [{ id: 'one', name: 'Project' }],
        incompleteSearch: true
      })
    }
  })

  await expect(makeFolder(api, { name: 'Child', in: 'Project' })).rejects.toThrow(
    'Folder search was incomplete'
  )
  expect(parents).toEqual([])
  expect((await makeFolder(api, { name: 'Child', in: knownId })).folder?.id).toBe(knownId)
  expect((await makeFolder(api, { name: 'Child', in: 'root' })).folder?.id).toBe('root')
  expect(parents).toEqual([[knownId], ['root']])
})
