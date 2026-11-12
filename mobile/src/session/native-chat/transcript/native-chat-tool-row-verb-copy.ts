import type { NativeChatToolRowVerb } from '../../../../../src/shared/native-chat/tools/native-chat-tool-line-label'
import type { Translate } from '../../../i18n/mobile-i18n'

export function nativeChatToolRowVerbCopy(t: Translate): Record<NativeChatToolRowVerb, string> {
  return {
    running: t('chat.nativeChatToolLine.running', 'Running'),
    ran: t('chat.nativeChatToolLine.ran', 'Ran'),
    reading: t('chat.nativeChatToolLine.reading', 'Reading'),
    read: t('chat.nativeChatToolLine.read', 'Read'),
    triedRead: t('chat.nativeChatToolLine.triedRead', 'Tried to read'),
    editing: t('chat.nativeChatToolLine.editing', 'Editing'),
    edited: t('chat.nativeChatToolLine.edited', 'Edited'),
    triedEdit: t('chat.nativeChatToolLine.triedEdit', 'Tried to edit'),
    added: t('chat.nativeChatToolLine.added', 'Added'),
    deleted: t('chat.nativeChatToolLine.deleted', 'Deleted'),
    renamed: t('chat.nativeChatToolLine.renamed', 'Renamed'),
    subagent: t('chat.nativeChatToolLine.subagent', 'Subagent'),
    searching: t('chat.nativeChatToolLine.searching', 'Searching'),
    searched: t('chat.nativeChatToolLine.searched', 'Searched'),
    triedSearch: t('chat.nativeChatToolLine.triedSearch', 'Tried to search'),
    listing: t('chat.nativeChatToolLine.listing', 'Listing'),
    listed: t('chat.nativeChatToolLine.listed', 'Listed'),
    triedList: t('chat.nativeChatToolLine.triedList', 'Tried to list'),
    fetching: t('chat.nativeChatToolLine.fetching', 'Fetching'),
    fetched: t('chat.nativeChatToolLine.fetched', 'Fetched'),
    triedFetch: t('chat.nativeChatToolLine.triedFetch', 'Tried to fetch'),
    searchingWeb: t('chat.nativeChatToolLine.searchingWeb', 'Searching the web'),
    searchedWeb: t('chat.nativeChatToolLine.searchedWeb', 'Searched the web'),
    triedSearchWeb: t('chat.nativeChatToolLine.triedSearchWeb', 'Tried to search the web')
  }
}
