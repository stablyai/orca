import type { Translate } from '../i18n/mobile-i18n'
import type {
  ChimeMode,
  LinkReading,
  ProjectNameMode,
  ReadScope,
  TableReading
} from '../storage/speech-preferences'
import type { Option } from './read-aloud-setting-rows'

export function readScopes(t: Translate): Option<ReadScope>[] {
  return [
    {
      value: 'all',
      label: t('settings.readAloudSettingsScreen.scopeAll', 'Every message'),
      sublabel: t(
        'settings.readAloudSettingsScreen.scopeAllDescription',
        'Also what the agent writes while it is still working'
      )
    },
    {
      value: 'all-on-screen',
      label: t(
        'settings.readAloudSettingsScreen.scopeOnScreen',
        'Every message on screen, final replies off screen'
      ),
      sublabel: t(
        'settings.readAloudSettingsScreen.scopeOnScreenDescription',
        'Everything while Orca is open; only the turn-ending answer with the screen off'
      )
    },
    {
      value: 'replies',
      label: t('settings.readAloudSettingsScreen.scopeReplies', 'Final replies only'),
      sublabel: t(
        'settings.readAloudSettingsScreen.scopeRepliesDescription',
        'Only the answer that ends a turn, as in notifications'
      )
    }
  ]
}

export function projectNameModes(t: Translate): Option<ProjectNameMode>[] {
  return [
    {
      value: 'on-change',
      label: t('settings.readAloudSettingsScreen.projectNameOnChange', 'When the project changes'),
      sublabel: t(
        'settings.readAloudSettingsScreen.projectNameOnChangeDescription',
        'Before a message from another project, or after two quiet minutes'
      )
    },
    {
      value: 'every',
      label: t('settings.readAloudSettingsScreen.projectNameEvery', 'Before every message'),
      sublabel: t(
        'settings.readAloudSettingsScreen.projectNameEveryDescription',
        'Even when several come from one agent'
      )
    },
    {
      value: 'off',
      label: t('settings.readAloudSettingsScreen.projectNameOff', 'Off'),
      sublabel: t('settings.readAloudSettingsScreen.projectNameOffDescription', 'Only the message')
    }
  ]
}

export function chimeModes(t: Translate): Option<ChimeMode>[] {
  return [
    {
      value: 'every',
      label: t('settings.readAloudSettingsScreen.chimeEvery', 'Before every message'),
      sublabel: t(
        'settings.readAloudSettingsScreen.chimeEveryDescription',
        'Also marks where one message ends and the next begins'
      )
    },
    {
      value: 'on-change',
      label: t('settings.readAloudSettingsScreen.chimeOnChange', 'When the project changes'),
      sublabel: t(
        'settings.readAloudSettingsScreen.chimeOnChangeDescription',
        'Same rule as the project name: another project, or after two quiet minutes'
      )
    },
    {
      value: 'off',
      label: t('settings.readAloudSettingsScreen.chimeOff', 'Off'),
      sublabel: t('settings.readAloudSettingsScreen.chimeOffDescription', 'No sound')
    }
  ]
}

// The sublabels quote what "Here is the source: [WHO report](https://www.who.int/…)" becomes.
export function linkReadings(t: Translate): Option<LinkReading>[] {
  return [
    {
      value: 'word-and-text',
      label: t(
        'settings.readAloudSettingsScreen.linkWordAndText',
        'The word “link”, then its text'
      ),
      sublabel: t(
        'settings.readAloudSettingsScreen.linkWordAndTextExample',
        '“Here is the source: link WHO report”'
      )
    },
    {
      value: 'word-text-site',
      label: t(
        'settings.readAloudSettingsScreen.linkWordTextSite',
        'The word “link”, its text and the site'
      ),
      sublabel: t(
        'settings.readAloudSettingsScreen.linkWordTextSiteExample',
        '“Here is the source: link WHO report, who.int”'
      )
    },
    {
      value: 'text',
      label: t('settings.readAloudSettingsScreen.linkText', 'Only its text'),
      sublabel: t(
        'settings.readAloudSettingsScreen.linkTextExample',
        '“Here is the source: WHO report”'
      )
    },
    {
      value: 'off',
      label: t('settings.readAloudSettingsScreen.linkOff', 'Skip links'),
      sublabel: t('settings.readAloudSettingsScreen.linkOffExample', '“Here is the source”')
    }
  ]
}

export function tableReadings(t: Translate): Option<TableReading>[] {
  return [
    {
      value: 'with-headers',
      label: t(
        'settings.readAloudSettingsScreen.tableWithHeaders',
        'Row by row, with column names'
      ),
      sublabel: t(
        'settings.readAloudSettingsScreen.tableWithHeadersExample',
        '“Day: Tuesday, Run: Intervals. Day: Thursday, Run: Easy run.”'
      )
    },
    {
      value: 'values',
      label: t('settings.readAloudSettingsScreen.tableValues', 'Row by row, values only'),
      sublabel: t(
        'settings.readAloudSettingsScreen.tableValuesExample',
        'The column names once, then the rows: “Day, Run. Tuesday, Intervals.”'
      )
    },
    {
      value: 'skip',
      label: t('settings.readAloudSettingsScreen.tableSkip', 'Skip tables'),
      sublabel: t('settings.readAloudSettingsScreen.tableSkipExample', '“Table skipped.”')
    }
  ]
}
