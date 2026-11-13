# Relay image data

The relay Dockerfile copies this directory into the runtime image at
`/app/apps/relay/ip-country`. In this repository it holds only this README.

A deployment may stage data files here before it builds the image. The director's
IP → country table is one: a CSV of `first,last,CC` ranges (IPv4 and IPv6, inclusive,
optionally gzipped) that `ORCA_RELAY_IP_COUNTRY_DB` names (`src/ip-country.ts`). Nothing
reads a file here unless that variable points at it, so an image built without the table
behaves exactly as before.

Whoever stages a third-party table also stages its licence notice next to it.
