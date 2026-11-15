#!/usr/bin/env bash
# Verify a desktop release tag before the release App pushes it or a cut reuses it.
# Usage: verify-release-tag.sh <ref> <version> <source-sha> [<commit-message>]
#   <ref>             local ref holding the tag (a fresh prepared tag, or an existing refs/tags/v<version>)
#   <commit-message>  exact message a fresh release commit must carry; omit it for an existing tag, whose
#                     message may be "release: v<version>" with or without an " [rc-slot:YYYY-MM-DD-HH]" suffix
# Fresh and existing tags must both be exactly what release-cut creates: an annotated tag by github-actions[bot]
# whose message is the tag name, pointing straight at the release commit. Tags release-cut prepares keep that
# tagger when the release App pushes them, so the App's own tags are recoverable and hand-made ones are not.
# Prints the verified release commit. Needs only git, bash, sed, cmp and jq, so it never runs code from the tag.
set -euo pipefail

ref="$1"
version="$2"
source_sha="$3"
message="${4-}"
tag="v$version"

fail() {
  echo "::error::Refusing release tag $tag: $1" >&2
  exit 1
}

[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+(\.[0-9A-Za-z]+)?)?$ ]] || fail "unexpected version shape"
[[ "$source_sha" =~ ^[0-9a-f]{40}$ ]] || fail "source is not a full commit SHA"
commit="$(git rev-parse --verify --quiet "${ref}^{commit}")" || fail "$ref does not resolve to a commit"
tag_re="${tag//./\\.}"

[[ "$(git cat-file -t "$ref")" == "tag" ]] || fail "it is not an annotated tag"
tag_object="$(git cat-file tag "$ref")"
header="${tag_object%%$'\n\n'*}"
header_re="^object $commit"$'\n'"type commit"$'\n'"tag $tag_re"$'\n'
header_re+='tagger github-actions\[bot\] <41898282\+github-actions\[bot\]@users\.noreply\.github\.com> [0-9]+ [+-][0-9]{4}$'
[[ "$header" =~ $header_re ]] || fail "the tag object is not the one release-cut creates"
[[ "${tag_object#*$'\n\n'}" == "$tag" ]] || fail "the tag message is not $tag"

commit_message="$(git log -1 --format=%B "$commit")"
if [[ -n "$message" ]]; then
  [[ "$commit_message" == "$message" ]] || fail "the release commit message is not '$message'"
else
  subject_re="^release: $tag_re( \[rc-slot:[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{2}\])?$"
  [[ "$commit_message" =~ $subject_re ]] || fail "its commit is not a release commit for $tag"
fi

scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
git cat-file blob "$commit:package.json" >"$scratch/release.json"
version_line='^[[:space:]]*"version"[[:space:]]*:'

# The release commit is the source itself (an existing tag cut there) or its only child, changing package.json alone.
if [[ "$commit" != "$source_sha" ]]; then
  [[ "$(git rev-list --parents -n 1 "$commit")" == "$commit $source_sha" ]] ||
    fail "its commit is not a direct child of source $source_sha"
  changes="$(git diff-tree --no-commit-id -r "$source_sha" "$commit")"
  if [[ -n "$changes" ]]; then
    change_re='^:100644 100644 [0-9a-f]{40} [0-9a-f]{40} M'$'\t''package\.json$'
    [[ "$changes" =~ $change_re ]] || fail "its commit changes more than package.json"
  fi
  # Byte-level: the source package.json with only its one "version" value replaced must be the release blob.
  git cat-file blob "$source_sha:package.json" >"$scratch/source.json"
  [[ "$(grep -c "\"version\"" "$scratch/source.json")" == 1 ]] ||
    fail "the source package.json does not have exactly one \"version\""
  sed -E "s/(${version_line}[[:space:]]*)\"[^\"]*\"/\\1\"$version\"/" "$scratch/source.json" >"$scratch/expected.json"
  cmp -s "$scratch/expected.json" "$scratch/release.json" ||
    fail "package.json changes more than its version"
fi
[[ "$(grep -c "\"version\"" "$scratch/release.json")" == 1 ]] ||
  fail "package.json does not have exactly one \"version\""
[[ "$(jq -r '.version' "$scratch/release.json")" == "$version" ]] ||
  fail "package.json version is not $version"

echo "$commit"
