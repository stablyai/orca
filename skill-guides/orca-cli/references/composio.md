# Composio apps

Composio connects many apps (Outlook, Notion, HubSpot, Jira and more) on your owner's own Composio account. Once your owner adds their Composio key, your `composio` tool reaches every app they connect for you. Your owner's app sign-ins are held by Composio. You never see the key; Orca keeps it.

## Setting it up

Orca draws the setup cards in your Chat from its own state. You ask for the next card with `ORCA bot composio setup --app <slug>`; you can't post cards yourself. Your owner's clicks reach you as "Card composio-setup/<card> answered: …".

1. When setup starts ("Composio setup started by your owner …") or your owner asks for an app Orca doesn't connect itself, say in a line or two what Composio is and that their app sign-in stays with Composio. Then run `ORCA bot composio setup --app <slug>`.
2. With no app picked, ask which app first. Slugs are lower case with `_`, for example `outlook`, `microsoft_teams`, `one_drive`, `hubspot`. Once the key is in, your `composio` tool's search names the slug.
3. "key answered: added; Orca shows the Connect <slug> card": that card is already in the chat. Wait for the sign-in.
   Describe the card as Orca's answer says it is. When it says the app needs a one-time setup in Composio, the card shows your owner the steps (their own developer app, added under Composio's Auth Configs); say that in a line, never that the app is ready to sign in.
4. "connect answered: <slug> connected as …": the app is ready. Say so in a line and ask what to do with it, with one example from what they asked earlier.
5. "connect answered: <slug> not connected": the sign-in didn't finish. Offer to try again with `ORCA bot composio setup --app <slug>`.
6. "key answered: not now": stop. They can pick the app again in Add connector.

Your `composio` tool can't connect apps itself; Orca's Connect card does. When it says an app has no active connection (even when it says to call COMPOSIO_MANAGE_CONNECTIONS) or its sign-in expired, run `ORCA bot composio setup --app <slug>`, so your owner gets the Connect card in Orca. Never pass on a Composio link.

## Using an app

Use your `composio` tool: search for the app's tools, then run them. Act as your owner asked. Draft rather than send unless they asked you to send. When a call says Composio's rate or plan limit is reached, tell your owner once and stop; don't retry. Orca shows the limit on the Composio apps row in your Tools.

## Starting work on an app event

A Composio trigger (for example "New Outlook Message") can start you through a webhook. A Composio project sends every event to one address, so Orca keeps one "Composio events" automation for it and hands each event to the automation of the bot it's for, by your Composio user and your automation's filter. Never edit or delete "Composio events".

1. Run `ORCA automations trigger-options --bot <your name>`, then make the automation: `ORCA automations create --bot <your name> --name "<name>" --on 'webhook.call where="body.metadata.trigger_slug = <TRIGGER_SLUG>" where="body.metadata.user_id = <your Composio user>"' ...`. `ORCA bot composio setup` prints your Composio user. The trigger keeps out the project's other triggers; the user is how Orca knows the event is yours. Orca adds the user filter itself when you ask for the events card, if it's missing.
2. Run `ORCA bot composio events --hook <hook id> --trigger <TRIGGER_SLUG>`, with `--config '<json>'` when the trigger takes settings. `ORCA webhooks list --bot <your name>` gives the hook id. On the card, one click turns the trigger on and, the first time, points the project's events at Orca's "Composio events" hook. Your other bots on this computer share that hook, so setting up one never moves another's events. When the project sends its events to another address, such as another computer's Orca or another tool, the card asks your owner first, and that address stops getting them.
3. "events answered: set up": it's on. Ask them to send a real test event, and check that it arrived.
4. "events answered: by hand": walk them through Composio's dashboard instead:
   - Under the project's Webhooks settings, they paste the URL they copy with Copy URL on the "Composio events" automation's card (it exists once any bot's events were set up on a card), then copy the signing secret Composio shows. In Orca, they open that webhook's Signing secret, choose Change…, pick Standard Webhooks and paste it.
   - Under Triggers, they turn on the trigger for the account they connected.
5. A trigger's call often carries only an id (Outlook's sends the message id). Read the item through your `composio` tool in the run.

A second trigger in the same Composio project reaches the same URL. Use one automation whose prompt handles each `body.metadata.trigger_slug`, or a `where=` with `in`, still with your user's `where=`.

When nothing arrives:

- The "Composio events" hook's calls (`ORCA webhooks calls --hook <its id>`) show none: the wait is on Composio's side. Some apps are checked every few minutes rather than right away. If it's still missing after 15 minutes, have your owner look at the trigger's log in Composio.
- Calls show as Refused: the reason after the call says why; read it before acting. Only a signature reason means your owner copies the signing secret from Composio again and pastes it under the webhook's Signing secret in Orca.
- Calls show as Refused with "not for any bot": no automation of yours matched its filter. The call on the "Composio events" hook shows what it held (its `metadata.user_id` and `metadata.trigger_slug`).
- When Composio says one of your sign-ins expired, Orca posts the Connect card in your Chat; tell your owner what stops working until they reconnect.

## Another automation service

Any service that can send a web request can start you the same way. Make the webhook, and have your owner point the service at its URL. A service that can't sign its calls uses the key in the URL instead: that's the sender your owner picks on the webhook card. Explain this only when your owner asks about a particular service.
