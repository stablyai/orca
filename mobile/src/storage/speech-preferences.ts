export const AUTO_READ_REPLIES_KEY = 'orca:autoReadReplies'
export const BACKGROUND_READING_KEY = 'orca:readAloudBackgroundReading'

/** An on/off setting, stored as text. */
export type StoredFlag = 'true' | 'false'

// Why: off by default, so replies are only spoken when the user asked for it.
export const DEFAULT_AUTO_READ_REPLIES: StoredFlag = 'false'
// Why: it only runs while auto-read is on, and reading with the phone pocketed is the point.
export const DEFAULT_BACKGROUND_READING: StoredFlag = 'true'

export const READ_SCOPE_KEY = 'orca:readAloudReadScope'

/**
 * `all`: every message, including what the agent writes while working. `replies`: only the answer
 * that ends a turn. `all-on-screen`: `all` while Orca is on screen, `replies` while it is not.
 */
export type ReadScope = 'all' | 'all-on-screen' | 'replies'

// Why: final replies alone miss everything an agent says while it works.
export const DEFAULT_READ_SCOPE: ReadScope = 'all'

export const PROJECT_NAME_MODE_KEY = 'orca:readAloudProjectName'

/** Whether auto-read names a message's project first; `on-change` only when it differs. */
export type ProjectNameMode = 'on-change' | 'every' | 'off'

// Why: tells agents apart without naming every message of one agent's run.
export const DEFAULT_PROJECT_NAME_MODE: ProjectNameMode = 'on-change'

export const CHIME_MODE_KEY = 'orca:readAloudChime'

/** Whether auto-read chimes before a message, by the same rule as the project name. */
export type ChimeMode = ProjectNameMode

// Why: marks where one message ends and the next begins when several are read back to back.
export const DEFAULT_CHIME_MODE: ChimeMode = 'every'

export const ANNOUNCE_WAITS_KEY = 'orca:readAloudAnnounceWaits'

/** Whether auto-read says when an agent stops to wait for the user (a question, a permission). */
export type AnnounceWaits = 'on' | 'off'

export const DEFAULT_ANNOUNCE_WAITS: AnnounceWaits = 'on'

export const LINK_READING_KEY = 'orca:readAloudLinks'

/**
 * How a link is read: `word-and-text` "link WHO report", `text` "WHO report", `word-text-site`
 * "link WHO report, who.int", `off` not at all. A bare address has no text, so it is "link".
 */
export type LinkReading = 'word-and-text' | 'text' | 'word-text-site' | 'off'

// Why: saying "link" sets a link's text apart from the sentence around it.
export const DEFAULT_LINK_READING: LinkReading = 'word-and-text'

export const HEADPHONES_ONLY_KEY = 'orca:readAloudHeadphonesOnly'

/** Whether auto-read stays quiet unless sound goes to headphones, a car or the like. */
export type HeadphonesOnly = 'on' | 'off'

export const DEFAULT_HEADPHONES_ONLY: HeadphonesOnly = 'off'

export const LANGUAGE_VOICES_KEY = 'orca:readAloudLanguageVoices'

/** Whether a sentence in another language is read with a voice for that language. */
export type LanguageVoices = 'on' | 'off'

export const DEFAULT_LANGUAGE_VOICES: LanguageVoices = 'on'

export const TABLE_READING_KEY = 'orca:readAloudTables'

/**
 * How a table is read: `with-headers` row by row as "Day: Tuesday, Run: intervals", `values` the
 * header row and then each row's cells, `skip` a short "Table skipped".
 */
export type TableReading = 'with-headers' | 'values' | 'skip'

// Why: agents often answer with tables, and a "Table skipped" cue loses what they say.
export const DEFAULT_TABLE_READING: TableReading = 'with-headers'
