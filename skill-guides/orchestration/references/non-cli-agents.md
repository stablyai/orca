# Non-CLI agent apps

Orca's participants are terminal CLI agents: supervised workers are CLI agents
Orca launches, and bots are Orca-native chat personas backed by a fixed set of
built-in CLI agents. A chat or desktop agent app with no terminal CLI cannot be
a worker or a bot, and there is no peer registration for it.

## One-way delegation

An external agent with shell access to the orca CLI can hand work to a bot on
this computer:

```text
ORCA orchestration send --to bot:<name> --type handoff --subject "<job>" --body "<what to do>"
ORCA orchestration send --to bot:<name> --type status --subject "<news>" --body "<information>"
```

`ORCA bot list` names the bots. A bare CLI caller sends as the owner: the bot
takes a `handoff` as its owner's own job and works it; the result lands in the
bot's chat, or the connected service the job names. `status` is information;
nothing comes back.

Answers do not return to the external app. A reply routes to the sender's Orca
mailbox (a terminal handle, session address, or dispatch), which a non-Orca app
does not have. Read a handoff's result where the bot posts it; do not wait for
mail that cannot arrive, and do not send `question` expecting an answer back.

Peer participation for non-CLI apps, with registration and a public reply
channel, is proposed in stablyai/orca#45310.
