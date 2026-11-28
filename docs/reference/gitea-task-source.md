# Gitea and Forgejo tasks

Gitea Tasks extends the existing hosted pull-request integration with issue and
pull-request browsing for the selected repositories. It does not replace GitHub
or GitLab Tasks. Existing profiles keep their chosen task sources: enable Gitea
in Settings → Tasks, then connect a server from the Gitea card in Settings →
Integrations.

## Connect a server

Create a personal access token in the server's user settings. For the full Tasks
workflow, select `read:user`, `write:issue`, and `write:repository`. Repository
permission covers pull-request reviews, file contents, statuses, and merging;
issue permission covers issue creation, edits, labels, assignees, and comments.
Restrict the token to the repositories you need when the server supports that
choice. The server's normal repository and merge permissions still apply.

Enter the server's web URL and token in Orca. Orca accepts HTTP and HTTPS server
URLs; URLs with embedded credentials, query strings or fragments are rejected.
Prefer HTTPS. Over plain HTTP the token crosses the network unencrypted and
anyone who can observe that traffic can reuse it, so only use an `http://` URL
on an isolated network or behind an authenticated encrypted tunnel (a VPN such
as WireGuard or Tailscale, or an SSH tunnel). Tokens use Orca's encrypted
credential store, and a token that cannot be decrypted is reported on the card.

`ORCA_GITEA_TOKEN` and `ORCA_GITEA_API_BASE_URL` keep working and take
precedence over saved servers. With `ORCA_GITEA_API_BASE_URL` set, the
environment token only goes to that API's host. Without it, Orca keeps the
original hosted-review behavior and sends `ORCA_GITEA_TOKEN` to the API of
whichever Gitea repository is open, so a token meant for one server can reach
another. Set `ORCA_GITEA_API_BASE_URL` alongside the token, or connect servers
in Settings instead, when you work with more than one Gitea host.

## Where credentials apply

A saved token, or an environment token scoped by `ORCA_GITEA_API_BASE_URL`, is
only sent to the server it belongs to: a saved server matches a repository by
its remote host (an SSH remote, which names no port, matches the
saved server on the same hostname). Requests that carry a token never follow
redirects. Pull request reads and creation use the same credentials as Tasks.

Repository calls run on the machine that owns the repository: the desktop for
local and SSH-hosted repositories, or the paired Orca server for repositories
it hosts. Credentials must exist on that machine. The Settings card manages the
servers of the runtime the client runs on (the desktop app, or the server a web
client is paired to); a paired server can also use the environment variables.
A plain folder without a Gitea remote has no Gitea tasks.

Gitea documents the token scopes in its
[API authentication guide](https://docs.gitea.com/development/oauth2-provider/).
Forgejo installations may expose different permission labels depending on their
version. No administrator token is required.

## Review the workflow

1. Open Tasks, select Gitea and one or more repositories, and switch between
   All, Issues and PRs and the Open, Assigned to me, Created and Closed filters.
2. Open an issue, change its title, label, or assignee, and post a comment.
3. Start a workspace from the issue and check that it keeps the linked issue.
4. Open a pull request and inspect its description, comments, files, and checks.
   A failed resource displays an error without discarding successful resources.
5. Disconnect the server in Settings and reload Tasks.

The Gitea phone views are not available yet, so the mobile app hides the Gitea
source.
