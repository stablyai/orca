import { BOT_GROUP_METHODS } from './bot-groups'
import { BOT_METHODS } from './bots'
import { BOT_TAKE_OVER_METHOD } from './bots-take-over'
import { BOT_RUN_SEND_AGAIN_METHOD } from './bots-run-send-again'
import { BOT_ACCESS_METHODS } from './bots-access'
import { BOT_SLACK_METHODS } from './bots-slack'
import { BOT_LINEAR_METHODS } from './bots-linear'
import { BOT_GITHUB_METHODS } from './bots-github'
import { BOT_CONNECT_METHODS } from './bots-connect'
import { BOT_LOOK_AROUND_METHODS } from './bots-look-around'
import { BOT_TIDY_UP_METHODS } from './bots-tidy-up'
import { BOT_WORK_METHODS } from './bots-work'
import { BOT_ITEMS_METHODS } from './bots-items'
import { BOT_CONNECTOR_OFFER_METHOD } from './bots-connector-offer'
import { GOOGLE_SETUP_METHODS } from './bots-google-setup'
import { GOOGLE_SETUP_SAVED_KEY_METHODS } from './bots-google-setup-saved-key'
import { BOT_REQUEST_OUTCOME_METHOD } from './bots-request-outcome'
import { WORKTREE_RELEASE_BOT_HOME_METHOD } from './bots-home-release'
import { BOT_CREATE_OFFER_METHOD } from './bots-create-offer'
import { BOT_TEMPLATE_METHODS } from './bots-templates'
import { BOT_IMPORT_METHODS } from './bots-import'
import { BOT_SHARE_METHODS } from './bots-share'
import { BOT_SHARE_RECEIVE_METHODS } from './bots-share-receive'
import { BOT_CONNECTORS_METHOD } from './bots-connectors'
import { BOT_TOOLS_METHODS } from './bots-tools'
import { BOT_TOOLS_OWNED_SIGN_IN_METHODS } from './bots-tools-owned-sign-in'
import { BOT_COMPOSIO_METHODS } from './bots-composio'
import { BOT_COMPOSIO_EVENTS_METHODS } from './bots-composio-events'
import { WEBHOOK_METHODS } from './webhooks'

export const BOT_RPC_METHODS = [
  ...BOT_METHODS,
  BOT_TAKE_OVER_METHOD,
  BOT_RUN_SEND_AGAIN_METHOD,
  ...BOT_GROUP_METHODS,
  ...BOT_ACCESS_METHODS,
  ...BOT_SLACK_METHODS,
  ...BOT_LINEAR_METHODS,
  ...BOT_GITHUB_METHODS,
  ...BOT_CONNECT_METHODS,
  ...BOT_LOOK_AROUND_METHODS,
  ...BOT_TIDY_UP_METHODS,
  ...BOT_WORK_METHODS,
  ...BOT_ITEMS_METHODS,
  BOT_CONNECTOR_OFFER_METHOD,
  ...GOOGLE_SETUP_METHODS,
  ...GOOGLE_SETUP_SAVED_KEY_METHODS,
  BOT_REQUEST_OUTCOME_METHOD,
  WORKTREE_RELEASE_BOT_HOME_METHOD,
  BOT_CREATE_OFFER_METHOD,
  ...BOT_TEMPLATE_METHODS,
  ...BOT_IMPORT_METHODS,
  ...BOT_SHARE_METHODS,
  ...BOT_SHARE_RECEIVE_METHODS,
  BOT_CONNECTORS_METHOD,
  ...BOT_TOOLS_METHODS,
  ...BOT_TOOLS_OWNED_SIGN_IN_METHODS,
  ...BOT_COMPOSIO_METHODS,
  ...BOT_COMPOSIO_EVENTS_METHODS,
  ...WEBHOOK_METHODS
] as const
