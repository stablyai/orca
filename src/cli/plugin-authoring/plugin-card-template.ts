import { PLUGIN_SIDEBAR_CARDS_SINCE } from '../../shared/plugins/contributions/plugin-sidebar-card-contribution'
import {
  COMMON_FILES,
  json,
  manifest,
  readme,
  type PluginTemplate,
  type PluginTemplateInput
} from './plugin-template-files'

// A review-first workspace card: the pull request leads, agents follow. Data only.
const CARD = {
  version: 1,
  facts: 1,
  vars: {
    checkTone:
      "review.status == 'failure' ? 'danger' : review.status == 'pending' ? 'warning' : 'success'",
    reviewState:
      "review.state == 'merged' ? 'merged' : review.state == 'closed' ? 'closed' : 'open'"
  },
  frame: { singleLine: false, statusLane: false },
  root: {
    el: 'Row',
    props: { fill: true, gap: 'xs', align: 'start', marker: 'parent-content' },
    children: [
      { el: 'StatusLane', props: { unreadAction: true } },
      {
        el: 'Stack',
        props: { grow: true, gap: 'sm', overflow: 'visible' },
        children: [
          {
            el: 'Row',
            props: { align: 'center', gap: 'md' },
            children: [
              { el: 'Title' },
              {
                el: 'Badge',
                when: 'git.conflictOperation != null',
                props: { text: '=git.conflictOperation', tone: 'warning' }
              }
            ]
          },
          {
            el: 'Row',
            when: 'review != null',
            props: { align: 'center', gap: 'md', inset: 'end' },
            children: [
              {
                el: 'Text',
                props: { text: "='#' + review.number", size: 'meta', muted: true, mono: true }
              },
              { el: 'Text', props: { text: '=review.title', size: 'meta', truncate: true } },
              { el: 'Badge', props: { text: '=vars.reviewState', tone: '=vars.checkTone' } }
            ]
          },
          {
            el: 'Text',
            when: "review == null && ws.kind == 'git'",
            props: {
              text: "='No pull request · ' + ws.branch",
              size: 'meta',
              muted: true,
              truncate: true
            }
          },
          { el: 'Agents' },
          { el: 'ChildToggle', when: 'lineage.toggleable' }
        ]
      }
    ]
  }
}

export function card(input: PluginTemplateInput): PluginTemplate {
  return {
    description: 'Workspace card for the left sidebar (data only, no approval needed)',
    files: {
      'orca-plugin.json': manifest(
        input,
        'A workspace card that leads with the pull request.',
        {
          execution: 'data',
          contributes: {
            sidebarCards: [{ id: input.id, title: input.name, template: 'cards/card.json' }]
          }
        },
        `>=${PLUGIN_SIDEBAR_CARDS_SINCE}`
      ),
      'cards/card.json': json(CARD),
      'README.md': readme(
        input,
        'An Orca workspace card. Edit `cards/card.json`: elements, props and `=expressions` over workspace facts are listed in docs/reference/plugin-sidebar-cards.md. Pick it in Orca under the plugin\'s page, "Use for workspaces".'
      ),
      ...COMMON_FILES
    }
  }
}
