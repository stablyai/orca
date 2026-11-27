// Who can ask › Add people: the desktop's BotWhoCanAskPicker as a page. Tick people found in one
// connector's workspace, then Add them together; whoever can already ask is left out.
import { useEffect, useState } from 'react'
import { BOT_MAX_MEMBERS, type BotMember } from '../../../src/shared/bot-types'
import { MobileSearchField } from '../components/controls/MobileSearchField'
import { MobileStateView } from '../components/feedback/MobileStateView'
import { ListGroup, ListRow, SectionHeader } from '../components/list/ListGroup'
import { SheetHeader } from '../components/nav-bar/SheetHeader'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { SettingsNote } from '../settings/settings-screen-frame'
import { MobileWhoCanAskMemberFace, WHO_FACE_INSET, whoCanAskName } from './MobileWhoCanAskRows'
import type { WhoCanAskConnector, WhoCanAskFound } from './who-can-ask-connectors'

const SEARCH_DEBOUNCE_MS = 250

type Search =
  | { status: 'loading' }
  | { status: 'ready'; found: WhoCanAskFound }
  | { status: 'failed'; error: string }

type Found = WhoCanAskFound['members'][number]

function useMemberSearch(
  connector: WhoCanAskConnector,
  query: string,
  idle: boolean
): { search: Search; retry: () => void } {
  const [search, setSearch] = useState<Search>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const { search: find, errorMessage } = connector
  useEffect(() => {
    if (!find || idle) {
      return
    }
    let current = true
    setSearch({ status: 'loading' })
    const timer = setTimeout(() => {
      void find(query.trim()).then((result) => {
        if (current) {
          setSearch(
            result.ok
              ? { status: 'ready', found: result.value }
              : { status: 'failed', error: errorMessage(result.error) }
          )
        }
      })
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      current = false
      clearTimeout(timer)
    }
    // Keyed by connector, not its search: a route read rebuilds that without changing what it finds.
  }, [connector.key, query, attempt, idle])
  return { search, retry: () => setAttempt((count) => count + 1) }
}

// Saved as the desktop saves it: a found person's picture is kept, their handle isn't; an app is
// marked so, so it draws as one.
const asMember = (found: Found, connector: WhoCanAskConnector): BotMember => ({
  id: found.id,
  name: found.name,
  ...(found.avatarUrl ? { avatarUrl: found.avatarUrl } : {}),
  ...(found.app ? { kind: 'app' as const } : {}),
  ...connector.stamp
})

const NoMatch = ({ title, detail }: { title: string; detail: string }) => (
  <MobileStateView title={title} message={detail} />
)

export function MobileBotWhoCanAskPicker(props: {
  connector: WhoCanAskConnector
  /** Everyone who can ask the agent, on every connector. */
  members: readonly BotMember[]
  /** Kept from a Give access the owner backed out of. */
  initialPicked: BotMember[]
  onCancel: () => void
  onPicked: (picked: BotMember[]) => void
}) {
  const t = useMobileTranslation()
  const { connector } = props
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<BotMember[]>(props.initialPicked)
  const needle = query.trim().toLowerCase()
  const idle = needle === '' ? connector.idleHint : undefined
  const { search, retry } = useMemberSearch(connector, query, idle !== undefined)
  const listed = connector.listed
  const added = new Set(listed.map((member) => member.id))
  const full =
    props.members.length + picked.length >= BOT_MAX_MEMBERS ||
    added.size + picked.length >= connector.max
  const isPicked = (id: string): boolean => picked.some((entry) => entry.id === id)
  const toggle = (member: BotMember): void =>
    setPicked((current) =>
      isPicked(member.id) ? current.filter((entry) => entry.id !== member.id) : [...current, member]
    )

  const found = search.status === 'ready' && !idle ? search.found.members : []
  const isOwner = (id: string): boolean => connector.ownerIds.includes(id)
  const addable = found.filter((person) => !added.has(person.id) && !isOwner(person.id))
  const handleLine = (name: string, handle: string | undefined) =>
    handle && handle !== name ? handle : undefined

  const pickRow = (member: BotMember, handle?: string) => {
    const on = isPicked(member.id)
    return (
      <ListRow
        key={member.id}
        leading={<MobileWhoCanAskMemberFace member={member} />}
        title={whoCanAskName(member)}
        subtitle={handleLine(member.name, handle)}
        selected={on}
        accessibilityRole="checkbox"
        disabled={full && !on}
        onPress={() => toggle(member)}
      />
    )
  }
  // Ticked people the current search no longer shows stay on top, so what's added is on screen.
  const offScreen = picked.filter((member) => !addable.some((person) => person.id === member.id))

  const people = idle ? (
    <MobileStateView title={idle.title} message={idle.detail} />
  ) : search.status === 'failed' ? (
    <MobileStateView
      title={search.error}
      action={{ label: t('bots.whoCanAsk.retry', 'Try again'), onPress: retry }}
    />
  ) : search.status === 'loading' ? (
    <MobileStateView loading title={t('bots.whoCanAsk.searching', 'Searching…')} />
  ) : addable.length > 0 ? (
    <>
      <SectionHeader title={connector.peopleHeading} />
      <ListGroup separatorInset={WHO_FACE_INSET}>
        {addable.map((person) =>
          pickRow(asMember(person, connector), handleLine(person.name, person.handle))
        )}
      </ListGroup>
    </>
  ) : found.length > 0 ? (
    <MobileStateView title={t('bots.whoCanAsk.allAdded', 'They can already ask')} />
  ) : needle === '' ? null : (
    <NoMatch {...connector.noMatch(query.trim())} />
  )
  // One line under the list: why rows stopped taking ticks, or that the list is cut short.
  const note = full
    ? t('bots.whoCanAsk.cap', '{{count}} people is the most here.', {
        count: Math.min(connector.max, BOT_MAX_MEMBERS - props.members.length + added.size)
      })
    : search.status === 'ready' && !idle && !search.found.complete
      ? t('bots.whoCanAsk.incomplete', 'Not everyone is listed. Search by name to find someone.')
      : null

  return (
    <>
      <SheetHeader
        title={t('bots.whoCanAsk.addPeople', 'Add people')}
        subtitle={connector.title}
        leading={{ label: t('bots.whoCanAsk.cancel', 'Cancel'), onPress: props.onCancel }}
        trailing={{
          label: t('bots.whoCanAsk.add', 'Add'),
          disabled: picked.length === 0,
          onPress: () => props.onPicked(picked)
        }}
      />
      <MobileSearchField
        value={query}
        onChangeText={setQuery}
        placeholder={connector.searchPlaceholder}
        autoFocus
      />
      {offScreen.length > 0 ? (
        <>
          <SectionHeader title={t('bots.whoCanAsk.selectedHeading', 'Selected')} />
          <ListGroup separatorInset={WHO_FACE_INSET}>
            {offScreen.map((member) => pickRow(member))}
          </ListGroup>
        </>
      ) : null}
      {people}
      {note ? <SettingsNote>{note}</SettingsNote> : null}
    </>
  )
}
