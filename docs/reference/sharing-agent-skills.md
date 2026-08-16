# Share and install agent skills

Orca can put one skill or a bundle of skills behind one unlisted, revocable link. Shared bundles
do not appear in search, a catalog, or a public index. Anyone who has an active link can inspect
and install its contents without signing in, so treat the link like a credential.

## Share skills

Publishing and link management require an Orca account in the desktop app.

1. Open **Skills** and choose **Share skills**.
2. Select one or more skills. One link can contain a large collection, such as 30 skills.
3. Review the bundle name, included skills and files, scripts, executable files, digest, account,
   and optional release notes.
4. Choose **Publish skill**, **Publish bundle**, or **Publish new version**, then copy the link.

Orca publishes an immutable version. Later changes do not silently alter a link's current bytes;
publish a new version to update the Cloud package.

Use **Settings → Share Skills** to copy or revoke active links. Revocation blocks new previews and
download grants. A grant issued immediately before revocation can remain usable for up to five
minutes, and revocation does not remove copies that recipients already installed.

## Install from a link

Opening an Orca skill link shows a preview before changing any files. You can also open **Skills**,
choose **Install from link**, and paste the URL.

1. Verify the author and organization.
2. Review the version, release notes, included skills, scripts, executable files, and digest.
3. Select all skills or only the ones you want.
4. Choose the destination machine and either global or workspace scope.
5. Review new, unchanged, updated, and conflicting skills, then choose **Install N skills**.

Supported destinations include the local machine, paired Orca runtimes, WSL, and SSH hosts. The
destination runtime resolves its own home and workspace paths, so folder workspaces and remote
filesystems do not borrow paths from the client machine.

Orca keeps one canonical installed copy and places it where supported agents can discover it.
Current provider coverage is documented in
[Agent skill provider paths](./agent-skill-provider-paths.md).

## Conflicts, updates, and rollback

**Keep local** is the default when an existing skill differs. Orca replaces modified content only
after you explicitly choose to discard it.

Open **Skills → Manage installs** to inspect managed skills and their immutable version history.
Installing the latest version performs an update; selecting an older retained version performs a
rollback. Both use the same protected install transaction. If a bundle changes between versions,
Orca updates only the selected skills that still exist in that version.

An interrupted install is recovered on restart. If Orca reports a conflict or partial result,
review the named skill and retry; completed skills do not need to be installed again.

## Remove an installed skill

Use **Skills → Manage installs → Remove**. Orca removes only copies and provider placements that it
owns and can verify. Modified or unowned files are preserved and reported. Discarding modified
content requires a separate explicit confirmation.

Removing a local install does not revoke its share or delete its Cloud package. Likewise,
revoking or deleting Cloud data does not reach into recipients' machines.

## Retention and deletion

- Upload grants expire after 15 minutes.
- Abandoned upload bytes are removed from quarantine after one day.
- Published versions have no automatic age-based deletion.
- Deleting a package revokes its links before unreferenced objects are deleted.
- Deleted GCS objects remain operator-recoverable through a seven-day soft-delete window.
- Installed copies remain until someone removes them on each destination machine.

Organization legal or retention requirements can override normal rollback and deletion timing.

## Trust and privacy

A skill is code from its author. `SKILL.md` can change agent behavior, and included scripts or
executables may run later when a person or agent uses the skill. Orca validates the package and
never executes its contents during installation, but you should install only from people you trust
and review unexpected scripts or executable files.

Orca records bounded operational identifiers and outcomes. Normal logs, telemetry, and support
bundles exclude skill contents, filenames, manifests, local paths, share URLs, upload policies,
download grants, credentials, and access lists.

If a link no longer works, ask its owner for an active link. Missing, expired, revoked, and deleted
links intentionally show the same response so Orca does not disclose private package existence.
