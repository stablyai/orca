# Use a unified operation execution pipeline for Scryer

Every Native Scryer Engine operation runs through one contract-driven execution pipeline. The pipeline owns cross-cutting behavior such as contract lookup, context/input validation, project resolution, authority, lock/lease checks, declared state reads/writes, side effects, and result envelopes; operation files own only Scryer domain semantics.
