package orca.authz.admin

import rego.v1

test_admin_allowed if {
	allow with input as {"actor": {"role": "admin", "id": "u1"}}
}

test_non_admin_denied if {
	not allow with input as {"actor": {"role": "user", "id": "u1"}}
}

test_missing_actor_denied if {
	not allow with input as {}
}

# TASK-BE-026: the additive admin_override clause is a no-op when
# data.orca.authz.admin_override is absent — old behavior unchanged.
test_non_admin_denied_when_override_data_absent if {
	not allow with input as {"actor": {"role": "user", "id": "u1"}}
}

# TASK-BE-026: with the override policy data present and the actor's id
# listed, a non-admin actor is additionally allowed.
test_non_admin_allowed_when_listed_in_override_data if {
	allow with input as {"actor": {"role": "user", "id": "u1"}}
		with data.orca.authz.admin_override as {"extra_admins": {"user_ids": ["u1"]}}
}

# TASK-BE-026: the override data being present does not allow an
# unlisted actor — only the exact listed id(s) are additionally allowed.
test_non_admin_denied_when_not_listed_in_override_data if {
	not allow with input as {"actor": {"role": "user", "id": "u2"}}
		with data.orca.authz.admin_override as {"extra_admins": {"user_ids": ["u1"]}}
}
