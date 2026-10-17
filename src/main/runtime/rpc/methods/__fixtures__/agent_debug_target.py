def checkout(subtotal, tax):
    total = subtotal + tax
    print(f"AGENT-DEBUG-TARGET total {total}")
    return total


if __name__ == "__main__":
    checkout(40, 2)
