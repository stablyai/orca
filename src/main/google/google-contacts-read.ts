// `orca contacts find`: a person's email by name, from the account's contacts, the people it has
// emailed ("other contacts") and the company directory, so "email Sam" needs no address.
import { z } from 'zod'
import type { ContactSource, ContactsFindView } from '../../shared/google/google-read-types'
import { GoogleToolError, parseGoogleJson, type GoogleApi } from './google-api-client'

const PEOPLE = 'https://people.googleapis.com/v1'
const PER_SOURCE = 10

const PersonSchema = z.object({
  names: z.array(z.object({ displayName: z.string().optional() })).default([]),
  emailAddresses: z.array(z.object({ value: z.string().optional() })).default([]),
  organizations: z
    .array(z.object({ title: z.string().optional(), name: z.string().optional() }))
    .default([])
})
type Person = z.infer<typeof PersonSchema>
const SearchSchema = z.object({
  results: z.array(z.object({ person: PersonSchema })).default([])
})
const DirectorySchema = z.object({ people: z.array(PersonSchema).default([]) })

function searchUrl(path: string, query: string, readMask: string, extra: [string, string][] = []) {
  const url = new URL(`${PEOPLE}/${path}`)
  url.searchParams.set('query', query)
  url.searchParams.set('readMask', readMask)
  url.searchParams.set('pageSize', String(PER_SOURCE))
  for (const [key, value] of extra) {
    url.searchParams.append(key, value)
  }
  return url.toString()
}

async function search(api: GoogleApi, source: ContactSource, query: string): Promise<Person[]> {
  switch (source) {
    case 'contacts': {
      // Google asks for an empty query first so the search sees fresh contacts.
      await api.get(
        'contacts',
        searchUrl('people:searchContacts', '', 'names'),
        parseGoogleJson(SearchSchema)
      )
      const url = searchUrl('people:searchContacts', query, 'names,emailAddresses,organizations')
      return (await api.get('contacts', url, parseGoogleJson(SearchSchema))).results.map(
        (r) => r.person
      )
    }
    case 'other': {
      await api.get(
        'contacts',
        searchUrl('otherContacts:search', '', 'names'),
        parseGoogleJson(SearchSchema)
      )
      const url = searchUrl('otherContacts:search', query, 'names,emailAddresses')
      return (await api.get('contacts', url, parseGoogleJson(SearchSchema))).results.map(
        (r) => r.person
      )
    }
    case 'directory': {
      const url = searchUrl(
        'people:searchDirectoryPeople',
        query,
        'names,emailAddresses,organizations',
        [
          ['sources', 'DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE'],
          ['sources', 'DIRECTORY_SOURCE_TYPE_DOMAIN_CONTACT']
        ]
      )
      return (await api.get('contacts', url, parseGoogleJson(DirectorySchema))).people
    }
  }
}

const SOURCES: readonly ContactSource[] = ['contacts', 'other', 'directory']

type Searched =
  | { source: ContactSource; people: Person[] }
  | { source: ContactSource; reason: string }

export async function findContacts(api: GoogleApi, query: string): Promise<ContactsFindView> {
  const wanted = query.trim()
  if (!wanted) {
    throw new GoogleToolError('Name someone to look up.')
  }
  const settled = await Promise.all(
    SOURCES.map(async (source): Promise<Searched> => {
      try {
        return { source, people: await search(api, source, wanted) }
      } catch (error) {
        // A personal account has no directory; one source failing never hides the others.
        return { source, reason: error instanceof Error ? error.message : String(error) }
      }
    })
  )
  const seen = new Set<string>()
  const people: ContactsFindView['people'] = []
  for (const result of settled) {
    for (const person of 'people' in result ? result.people : []) {
      const emails = person.emailAddresses
        .flatMap((entry) => (entry.value ? [entry.value.toLowerCase()] : []))
        .filter((email) => !seen.has(email))
      if (emails.length === 0) {
        continue
      }
      emails.forEach((email) => seen.add(email))
      const organization = person.organizations[0]
      const title = [organization?.title, organization?.name].filter(Boolean).join(', ')
      people.push({
        name: person.names[0]?.displayName ?? emails[0] ?? '',
        emails,
        source: result.source,
        ...(title ? { title } : {})
      })
    }
  }
  return {
    account: api.email,
    query: wanted,
    people,
    skipped: settled.flatMap((result) =>
      'reason' in result ? [{ source: result.source, reason: result.reason }] : []
    )
  }
}
