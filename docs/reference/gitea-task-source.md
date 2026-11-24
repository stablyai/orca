# Gitea and Forgejo tasks

Gitea Tasks extends the existing hosted pull-request integration with issue and
pull-request browsing for the selected repositories. It does not replace GitHub
or GitLab Tasks. Existing profiles keep their chosen task sources: enable Gitea
in Settings → Tasks, then connect a server in Settings → Integrations.

## Connect a server

Create a personal access token in the server's user settings. For the full Tasks
workflow, select `read:user`, `write:issue`, and `write:repository`. Repository
permission covers pull-request reviews, file contents, statuses, and merging;
issue permission covers issue creation, edits, labels, assignees, and comments.
Restrict the token to the repositories you need when the server supports that
choice. The server's normal repository and merge permissions still apply.

Enter the server's web URL and token in Orca. HTTPS is required except for
loopback HTTP used by local development instances. Non-default HTTPS ports are
part of the credential destination. Redirects are rejected so authentication
cannot move to a different server. Tokens use Orca's existing encrypted
credential store; a token that cannot be decrypted is reported in Settings.

Add the repository to Orca and select it in Tasks. Credentials are matched to
its remote host. A plain folder without a matching Git remote has no
repository-scoped Gitea tasks. For SSH-hosted workspaces, repository discovery
uses the existing connection-aware repository resolver; API calls use the
desktop integration credentials, so the server must be reachable from Orca.

Gitea documents the token scopes in its
[API authentication guide](https://docs.gitea.com/development/oauth2-provider/).
Forgejo installations may expose different permission labels depending on their
version. No administrator token is required.

## Review the workflow

1. Open Tasks, select Gitea and a repository, and open an issue.
2. Change its title, label, or assignee. Labels outside the first repository
   label page are preserved by their numeric IDs.
3. Post a comment and check that the returned author appears.
4. Start a workspace and check that its linked task uses the saved title.
5. Open a pull request and inspect its description, comments, files, and checks.
   A failed resource displays an error without discarding successful resources.
6. Replace or disconnect the server credentials and reload Tasks. Cached task
   data and requests from the previous credentials cannot repopulate the cache.

`tests/e2e/gitea-tasks.spec.ts` exercises issue editing and comments in a hidden
Electron renderer with deterministic IPC fixtures. It does not substitute for
testing an actual Gitea or Forgejo deployment. Backend tests cover API mapping,
credential destinations, connection status, and mutations; renderer tests cover
cache invalidation, label preservation, and partial pull-request loading.
