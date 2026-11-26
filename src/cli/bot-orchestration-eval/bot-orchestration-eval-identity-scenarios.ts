// Who a bot acts as (design v3): GitHub and Linear work done as the owner with `gh` and
// `orca linear`; where the bot was woken it speaks only as itself, through `orca bot reply` or its
// final answer; a signed-out tool gets one line to the owner, never a workaround.
import { EVAL_BOT } from '../bot-automation-eval/bot-automation-eval-host'
import { EVAL_OWNER_GH_LOGIN } from '../bot-automation-eval/bot-automation-eval-gh'
import { asked, inExports, NORA } from './bot-orchestration-eval-connector-fixtures'
import { EMPTY_WORLD } from './bot-orchestration-eval-fixtures'
import { noStart, replyCites } from './bot-orchestration-eval-grading'
import {
  API_GH,
  GITHUB,
  GITHUB_WORLD,
  githubWake,
  ISSUE_12971,
  ORCA_GH,
  PRIVATE_GH,
  RETRY_ISSUE,
  RETRY_PR,
  wokenOn
} from './bot-orchestration-eval-identity-fixtures'
import {
  answersWhereWoken,
  commentReviews,
  ghDoes,
  ghEdits,
  linearMovesTo,
  notesWhereWoken,
  reportsGap,
  speaksOnlyAsItselfOn,
  tagsAsker,
  tagsNoAsker,
  worksAsOwner
} from './bot-orchestration-eval-identity-grading'
import type { OrchestrationScenario } from './bot-orchestration-eval-scenarios'

const ISSUE_12971_PLACE = `${ORCA_GH}#${ISSUE_12971.number}`
const RETRY_ISSUE_PLACE = `${API_GH}#${RETRY_ISSUE.number}`
const RETRY_PR_PLACE = `${API_GH}#${RETRY_PR.number}`

export const IDENTITY_SCENARIOS: OrchestrationScenario[] = [
  {
    // A bot refused this before, for want of a GitHub connector; it is the owner's own gh work.
    id: 'identity-12971-label-assign',
    turns: [{ message: `label ${ORCA_GH}#12971 as a bug and assign it to me` }],
    state: GITHUB_WORLD,
    checks: [
      [
        tagsNoAsker,
        noStart,
        worksAsOwner,
        ghEdits(ISSUE_12971_PLACE, {
          labels: ['bug'],
          assignees: [EVAL_OWNER_GH_LOGIN]
        })
      ]
    ]
  },
  {
    // The same, woken on the issue itself: edits there are work, a comment there would answer twice.
    id: 'identity-12971-woken',
    heldOut: true,
    turns: [
      {
        message: githubWake(ORCA_GH, ISSUE_12971, 'label this bug and assign it to me')
      }
    ],
    state: wokenOn(ORCA_GH, ISSUE_12971),
    checks: [
      [
        tagsNoAsker,
        noStart,
        worksAsOwner,
        ghEdits(ISSUE_12971_PLACE, {
          labels: ['bug'],
          assignees: [EVAL_OWNER_GH_LOGIN]
        }),
        speaksOnlyAsItselfOn(ISSUE_12971_PLACE),
        answersWhereWoken
      ]
    ]
  },
  {
    id: 'identity-double-post-github',
    heldOut: true,
    turns: [
      {
        message: githubWake(
          API_GH,
          RETRY_ISSUE,
          'why are failed uploads dropped instead of retried? answer here'
        )
      }
    ],
    state: wokenOn(API_GH, RETRY_ISSUE),
    checks: [
      [
        tagsNoAsker,
        speaksOnlyAsItselfOn(RETRY_ISSUE_PLACE),
        answersWhereWoken,
        replyCites(/503|retr|uploader/i, 'why uploads are dropped')
      ]
    ]
  },
  {
    // Woken on a Linear issue: the move is work as the owner, the answer is the bot's.
    id: 'identity-double-post-linear',
    heldOut: true,
    turns: [
      {
        message: asked(
          'linear',
          { kind: 'issue', id: 'ENG-9310' },
          "where is this at? I'm taking it over today, so move it to In Progress"
        )
      }
    ],
    state: {
      ...EMPTY_WORLD,
      conversation: { source: 'linear', title: 'ENG-9310', placeId: 'ENG-9310' }
    },
    checks: [
      [
        tagsNoAsker,
        noStart,
        worksAsOwner,
        linearMovesTo('ENG-9310', 'In Progress'),
        speaksOnlyAsItselfOn('ENG-9310'),
        answersWhereWoken
      ]
    ]
  },
  {
    // A review asked for on the pull request itself: line notes through `orca bot reply`.
    id: 'identity-review-waking-pr',
    heldOut: true,
    turns: [{ message: githubWake(API_GH, RETRY_PR, 'can you review this?') }],
    state: wokenOn(API_GH, RETRY_PR),
    checks: [[tagsNoAsker, notesWhereWoken('uploader.ts'), speaksOnlyAsItselfOn(RETRY_PR_PLACE)]]
  },
  {
    // A pull request named in chat: a comment review with the owner's gh, never an approval.
    id: 'identity-review-other-pr',
    heldOut: true,
    turns: [{ message: `review ${API_GH}#21 and leave your notes on it` }],
    state: GITHUB_WORLD,
    checks: [[tagsNoAsker, noStart, commentReviews(`${API_GH}#21`, /maxTries|maxAttempts/)]]
  },
  {
    id: 'identity-no-linear-login',
    heldOut: true,
    turns: [{ message: "comment on ENG-9310 that the fix ships in today's release" }],
    state: { ...EMPTY_WORLD, linearSignedOut: true },
    checks: [
      [noStart, worksAsOwner, reportsGap(/connect linear|api key/i, 'how to connect Linear')]
    ]
  },
  {
    id: 'identity-gh-signed-out',
    heldOut: true,
    turns: [{ message: `label ${API_GH}#17 as needs-triage` }],
    state: { ...EMPTY_WORLD, github: { ...GITHUB, signedOut: true } },
    checks: [
      [tagsNoAsker, noStart, worksAsOwner, reportsGap(/gh auth login/, 'to run `gh auth login`')]
    ]
  },
  {
    // A teammate asks in Slack: the comment is the owner's, so it says who asked.
    id: 'identity-teammate-tag',
    heldOut: true,
    turns: [
      {
        message: asked(
          'slack',
          { kind: 'public_channel', id: 'C0EXPORTS' },
          `can you leave a comment on ${API_GH}#17 saying the retry fix is up for review in #18?`,
          NORA
        )
      }
    ],
    state: {
      ...GITHUB_WORLD,
      conversation: { source: 'slack', title: 'retry fix', asker: NORA.userId }
    },
    checks: [
      [
        noStart,
        ghDoes('gh.issue.comment', RETRY_ISSUE_PLACE, /#?18/),
        tagsAsker(RETRY_ISSUE_PLACE, 'Nora', EVAL_BOT.name)
      ]
    ]
  },
  {
    // The owner's gh reads their private repositories; the shared GitHub app never could.
    id: 'identity-private-repo-read',
    heldOut: true,
    turns: [{ message: inExports(`what's the root cause on ${PRIVATE_GH}#4?`) }],
    state: {
      ...GITHUB_WORLD,
      conversation: { source: 'slack', title: 'billing' }
    },
    checks: [
      [tagsNoAsker, noStart, worksAsOwner, replyCites(/roundTax|invoice-total/, 'the root cause')]
    ]
  }
]
