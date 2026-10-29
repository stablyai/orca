import type {
  ChimeMode,
  LinkReading,
  ProjectNameMode,
  ReadScope,
  TableReading
} from '../storage/speech-preferences'
import type { Option } from './read-aloud-setting-rows'

export const READ_SCOPES: Option<ReadScope>[] = [
  {
    value: 'all',
    label: 'Every message',
    sublabel: 'Also what the agent writes while it is still working'
  },
  {
    value: 'all-on-screen',
    label: 'Every message on screen, final replies off screen',
    sublabel: 'Everything while Orca is open; only the turn-ending answer with the screen off'
  },
  {
    value: 'replies',
    label: 'Final replies only',
    sublabel: 'Only the answer that ends a turn, as in notifications'
  }
]

export const PROJECT_NAME_MODES: Option<ProjectNameMode>[] = [
  {
    value: 'on-change',
    label: 'When the project changes',
    sublabel: 'Before a message from another project, or after two quiet minutes'
  },
  {
    value: 'every',
    label: 'Before every message',
    sublabel: 'Even when several come from one agent'
  },
  { value: 'off', label: 'Off', sublabel: 'Only the message' }
]

export const CHIME_MODES: Option<ChimeMode>[] = [
  {
    value: 'every',
    label: 'Before every message',
    sublabel: 'Also marks where one message ends and the next begins'
  },
  {
    value: 'on-change',
    label: 'When the project changes',
    sublabel: 'Same rule as the project name: another project, or after two quiet minutes'
  },
  { value: 'off', label: 'Off', sublabel: 'No sound' }
]

// The sublabels quote what "Here is the source: [WHO report](https://www.who.int/…)" becomes.
export const LINK_READINGS: Option<LinkReading>[] = [
  {
    value: 'word-and-text',
    label: 'The word “link”, then its text',
    sublabel: '“Here is the source: link WHO report”'
  },
  {
    value: 'word-text-site',
    label: 'The word “link”, its text and the site',
    sublabel: '“Here is the source: link WHO report, who.int”'
  },
  {
    value: 'text',
    label: 'Only its text',
    sublabel: '“Here is the source: WHO report”'
  },
  { value: 'off', label: 'Skip links', sublabel: '“Here is the source”' }
]

export const TABLE_READINGS: Option<TableReading>[] = [
  {
    value: 'with-headers',
    label: 'Row by row, with column names',
    sublabel: '“Day: Tuesday, Run: Intervals. Day: Thursday, Run: Easy run.”'
  },
  {
    value: 'values',
    label: 'Row by row, values only',
    sublabel: 'The column names once, then the rows: “Day, Run. Tuesday, Intervals.”'
  },
  { value: 'skip', label: 'Skip tables', sublabel: '“Table skipped.”' }
]
